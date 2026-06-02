const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js")
const qrcode = require("qrcode-terminal")
const qrimage = require("qr-image");

const fs = require("fs");
const path = require("path");
const { PhoneNumberUtil, PhoneNumberFormat } = require("google-libphonenumber");
const phoneUtil = PhoneNumberUtil.getInstance();
const ffmpeg = require("fluent-ffmpeg");
const { db: getDb } = require("./connect.js");

const clients = {}
const authenticatedClients = {}
const qrcodes = {}

const MEDIA_DIR     = path.resolve(__dirname, 'media');
const PICS_CACHE_DIR = path.resolve(__dirname, 'cache', 'pics');
const PICS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 horas

try { fs.mkdirSync(PICS_CACHE_DIR, { recursive: true }); } catch (_) {}

// Normaliza una dirección WA sin mutilar el sufijo de servidor.
// Soporta @c.us (teléfono), @lid (multi-device), @g.us (grupo).
function normalizeAddr(addr) {
    addr = String(addr).replace(/;interface=wifi/gi, "").trim();
    if (addr.includes('@')) return addr;   // ya tiene sufijo → no tocar
    return addr + '@c.us';                 // número sin sufijo → añadir @c.us
}

function ffmpegPromise(inputPath, outputPath, options = []) {
    return new Promise((resolve, reject) => {
        let cmd = ffmpeg().input(inputPath);
        if (options.length) cmd = cmd.outputOptions(options);
        cmd.output(outputPath)
            .on("end", resolve)
            .on("error", reject)
            .run();
    });
}

function startClient(id) {
    // Eliminar SingletonLock obsoleto si existe (evita "browser already running" tras crash)
    const lockFile = path.join(__dirname, '.wwebjs_auth', `session-${id}`, 'SingletonLock');
    try { fs.unlinkSync(lockFile); console.log(`[${id}] SingletonLock eliminado`); } catch (_) {}

    clients[id] = new Client({
        authStrategy: new LocalAuth({ clientId: id }),
        puppeteer: {
            headless: true,
            executablePath: '/usr/bin/google-chrome',
            args: ['--no-sandbox'],
        },
    })

    clients[id].initialize().catch(err => console.error(`[${id}] init error:`, err))

    clients[id].on("qr", (qr) => {
        console.log("QR code generated");
        qrcodes[id] = qr;
    })

    clients[id].on("ready", () => {
        authenticatedClients[id] = id;
        console.log("Client is ready!")
        syncHistory(id).catch(err => console.error(`[${id}] syncHistory error:`, err));
    })

    // Captura mensajes enviados desde OTROS dispositivos vinculados (móvil, web, PC).
    clients[id].on('message_create', async message => {
        if (!message.fromMe) return; // los recibidos los gestiona el evento 'message'
        if (!clients[id]?.info) return;

        const waId = message.id?._serialized;

        // Deduplicar: saltar si ya fue guardado por sendMessage() o por sincronización anterior
        if (waId) {
            const exists = await getDb().get('SELECT _id FROM messages WHERE wa_id = ?', [waId]);
            if (exists) return;
        }

        const myAddr  = clients[id].info.wid.user + '@c.us';
        const toAddr  = normalizeAddr(message.to || '');
        if (!toAddr || toAddr === myAddr && !message.to) return; // ignorar mensajes malformados

        const msgText = message.type === 'chat' ? (message.body || '') : `${message.type} sent`;
        const pushname = clients[id].info.pushname || 'Me';

        try {
            const contactName = await resolveContactName(clients[id], toAddr);

            await getDb().run('DELETE FROM chats WHERE sender = ?', [toAddr]);
            await getDb().run(
                `INSERT INTO chats(sender, receiver, message, status, sender_name, chat_type, device_type)
                 VALUES(?, ?, ?, ?, ?, ?, ?)`,
                [toAddr, myAddr, msgText, 0, contactName, message.type || 'chat', message.deviceType || 'unknown']
            );
            await getDb().run(
                `INSERT INTO messages(sender, receiver, message, status, sender_name, chat_type, device_type, wa_id)
                 VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
                [myAddr, toAddr, msgText, 0, pushname, message.type || 'chat', message.deviceType || 'unknown', waId || null]
            );
            console.log(`[message_create] guardado: ${pushname} → ${toAddr}: ${msgText.substring(0, 40)}`);
        } catch (err) {
            console.error('[message_create] error:', err.message);
        }
    })

    clients[id].on('disconnected', async (reason) => {
        console.log(`Client disconnected (${reason}), restarting...`);
        delete authenticatedClients[id];
        try {
            await clients[id].destroy();
            await clients[id].initialize();
        } catch (err) {
            console.error(`[${id}] restart error:`, err);
        }
    });

    clients[id].on('change_state', (state) => {
        console.log('Connection state changed:', state);
    });

    clients[id].on('message', async message => {
        console.log(`Message from: ${message.from}`);

        const waUser = await message.getContact();
        const waChat = await message.getChat();

        let msg;
        if (message.type == 'ptt')        msg = 'Voice received';
        else if (message.type == 'image') msg = 'Image received';
        else if (message.type == 'audio') msg = 'Audio received';
        else if (message.type == 'video') msg = 'Video received';
        else if (message.type == 'chat')  msg = message.body;
        else                              msg = `${message.type} received`;

        console.log(`Message: ${msg}`);

        if (message.from === 'status@broadcast') return;

        const waId = message.id?._serialized;

        // Deduplicate: skip if already in DB (from uploadMedia or previous sync)
        if (waId) {
            const exists = await getDb().get('SELECT _id FROM messages WHERE wa_id = ?', [waId]);
            if (exists) {
                console.log(`[message] Skipping duplicate wa_id: ${waId}`);
                return;
            }
        }

        let senderNameForChat     = message._data.notifyName;
        let senderNameForMessages = message._data.notifyName;

        if (waChat.isGroup)          senderNameForChat     = waChat.name;
        if (!senderNameForMessages)  senderNameForMessages = message.from;
        if (!senderNameForChat)      senderNameForChat     = message.from;

        // Update or insert chat; increment unread_count for new messages
        const existingChat = await getDb().get('SELECT unread_count FROM chats WHERE sender = ?', [message.from]);
        const newUnreadCount = (existingChat?.unread_count || 0) + 1;

        await getDb().run(
            `DELETE FROM chats WHERE sender = ?`,
            [message.from]
        );

        await getDb().run(
            `INSERT INTO chats(sender, receiver, message, status, sender_name, chat_type, device_type, unread_count)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
            [message.from, message.to, msg, 0, senderNameForChat, message.type, message.deviceType, newUnreadCount]
        );

        const result = await getDb().run(
            `INSERT INTO messages(sender, receiver, message, status, sender_name, chat_type, device_type, wa_id)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
            [message.from, message.to, msg, 0, senderNameForMessages, message.type, message.deviceType, waId]
        );

        const newId = result.lastID;

        if (message.hasMedia) {
            try {
                const media = await message.downloadMedia();

                if (message.type === 'image') {
                    let fileExt = '.jpg';
                    if (media.mimetype === 'image/webp') fileExt = '.webp';

                    const mediaFilename = newId + fileExt;
                    fs.writeFileSync(path.join(MEDIA_DIR, mediaFilename), Buffer.from(media.data, 'base64'));

                    await getDb().run(
                        `UPDATE messages SET media_filename = ? WHERE _id = ?`,
                        [mediaFilename, newId]
                    );
                }

                else if (message.type === 'audio' || message.type === 'ptt') {
                    const srcPath  = path.join(MEDIA_DIR, newId + '.ogg');
                    const destPath = path.join(MEDIA_DIR, newId + '.mp3');

                    fs.writeFileSync(srcPath, Buffer.from(media.data, 'base64'));
                    await ffmpegPromise(srcPath, destPath, ['-codec:a libmp3lame']);
                    fs.unlinkSync(srcPath);
                    console.log("Audio conversion finished");

                    await getDb().run(
                        `UPDATE messages SET media_filename = ? WHERE _id = ?`,
                        [newId + '.mp3', newId]
                    );
                }

                else if (message.type === 'video') {
                    const srcPath  = path.join(MEDIA_DIR, newId + '.mp4');
                    const destPath = path.join(MEDIA_DIR, newId + '.3gp');

                    fs.writeFileSync(srcPath, Buffer.from(media.data, 'base64'));
                    await ffmpegPromise(srcPath, destPath, [
                        '-s 352x288', '-acodec aac', '-strict experimental',
                        '-ac 1', '-ar 8000', '-ab 24k'
                    ]);
                    console.log("Video conversion finished");

                    await getDb().run(
                        `UPDATE messages SET media_filename = ? WHERE _id = ?`,
                        [newId + '.3gp', newId]
                    );
                }

            } catch (err) {
                console.error(`[msg ${newId}] Error saving media:`, err);
            }
        }
    });
}


function getStatus(clientId) {
    if (authenticatedClients[clientId] == undefined) {
        return { isAuthenticated: false, qr: qrcodes[clientId], pushname: null, user: null, platform: null }
    }
    return {
        isAuthenticated: true,
        qr:       qrcodes[clientId],
        pushname: clients[clientId]?.info?.pushname  ?? "",
        user:     clients[clientId]?.info?.wid?.user ?? "",
        platform: clients[clientId]?.info?.platform  ?? ""
    }
}

function validate(input, countryCode) {
    try {
        if (countryCode == "0")
            return { valid: false, reason: "Country code is required" }

        const number = phoneUtil.parse(input, countryCode);
        return {
            valid:     phoneUtil.isValidNumber(number),
            formatted: phoneUtil.format(number, PhoneNumberFormat.E164),
            type:      phoneUtil.getNumberType(number),
            country:   phoneUtil.getRegionCodeForNumber(number),
        };
    } catch (e) {
        return { valid: false, reason: e.message };
    }
}

async function loginUser(mobileNumber) {
    try {
        const regex = /;interface=wifi/gi;
        mobileNumber = mobileNumber.replace(regex, "");

        console.log(`login user = ${mobileNumber}`);

        const client = clients[mobileNumber.replace("@c.us", "")];
        if (!client?.info?.wid?.user)
            return { status: 401, data: { error: "User session not found" } };

        return {
            status: 200,
            data: {
                pushname: client.info.pushname,
                user:     client.info.wid.user,
                platform: client.info.platform
            }
        };
    } catch (error) {
        console.error(error);
        return { status: 500, data: { error: error.message } };
    }
}

async function logoutUser(mobileNumber) {
    try {
        const regex = /;interface=wifi/gi;
        mobileNumber = mobileNumber.replace(regex, "");
        const id = mobileNumber.replace("@c.us", "");

        if (clients[id]) {
            await clients[id].destroy();
            delete clients[id];
        }
        delete authenticatedClients[id];
        delete qrcodes[id];

        return { status: 200, data: { message: 'Logged out successfully' } };
    } catch (error) {
        console.error(error);
        return { status: 500, data: { error: error.message } };
    }
}

function parsePagination(pageRaw, pageSizeRaw) {
    const page     = Math.max(0, parseInt(pageRaw, 10)     || 0);
    const pageSize = Math.max(1, parseInt(pageSizeRaw, 10) || 30);
    return { page, pageSize };
}

async function getChats(receiver, pageRaw, pageSizeRaw) {
    try {
        const regex = /;interface=wifi/gi;
        receiver = receiver.replace(regex, "");

        const client = clients[receiver.replace("@c.us", "")];
        if (!client)
            return { status: 401, data: { error: "User session not found" } };

        const { page, pageSize } = parsePagination(pageRaw, pageSizeRaw);

        const rows = await getDb().all(
            `SELECT * FROM chats WHERE receiver = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
            [receiver, pageSize, page * pageSize]
        );

        const chats = rows.map(row => ({
            _id:        row._id,
            sender:     row.sender,
            senderName: row.sender_name,
            message:    row.message,
            status:     row.status,
            createdAt:  row.timestamp,
            updatedAt:  row.timestamp
        }));

        return { status: 200, data: { chats } };

    } catch (error) {
        console.error(error);
        return { status: 500, data: { error: error.message } };
    }
}

async function getAllChats(mobileNumber) {
    try {
        const regex = /;interface=wifi/gi;
        mobileNumber = mobileNumber.replace(regex, "");

        const client = clients[mobileNumber.replace("@c.us", "")];
        if (!client)
            return { status: 401, data: { error: "User session not found" } };

        const chats = await client.getChats();
        return { status: 200, data: { chats } };

    } catch (error) {
        console.error(error);
        return { status: 500, data: { error: error.message } };
    }
}

async function getAllMessages(mobileNumber, chatId) {
    try {
        const regex = /;interface=wifi/gi;
        mobileNumber = mobileNumber.replace(regex, "");

        const client = clients[mobileNumber.replace("@c.us", "")];
        if (!client)
            return { status: 401, data: { error: "User session not found" } };

        const chat = await client.getChatById(chatId);
        if (!chat)
            return { status: 404, data: { error: "Chat not found" } };

        const messages = await chat.fetchMessages({ limit: 50 });
        return { status: 200, data: { messages } };

    } catch (error) {
        console.error(error);
        return { status: 500, data: { error: error.message } };
    }
}

async function getMessages(receiver, sender, pageRaw, pageSizeRaw) {
    try {
        const regex = /;interface=wifi/gi;
        sender   = sender.replace(regex, "");
        receiver = receiver.replace(regex, "");

        const client = clients[receiver.replace("@c.us", "")];
        if (!client)
            return { status: 401, data: { error: "User session not found" } };

        const { page, pageSize } = parsePagination(pageRaw, pageSizeRaw);

        const rows = await getDb().all(
            `SELECT * FROM messages
             WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
             ORDER BY timestamp DESC
             LIMIT ? OFFSET ?`,
            [receiver, sender, sender, receiver, pageSize, page * pageSize]
        );

        const messages = rows.map(row => ({
            _id:           row._id,
            sender:        row.sender,
            receiver:      row.receiver,
            message:       row.message,
            status:        row.status,
            senderName:    row.sender_name,
            chatType:      row.chat_type,
            deviceType:    row.device_type,
            mediaFilename: row.media_filename,
            createdAt:     row.timestamp,
            updatedAt:     row.timestamp
        }));

        return { status: 200, data: { messages } };

    } catch (error) {
        console.error(error);
        return { status: 500, data: { error: error.message } };
    }
}

async function getContacts(mobileNumber, searchTerm, pageRaw, pageSizeRaw) {
    try {
        const regex = /;interface=wifi/gi;
        mobileNumber = mobileNumber.replace(regex, "");

        const client = clients[mobileNumber.replace("@c.us", "")];
        if (!client)
            return { status: 401, data: { error: "User session not found" } };

        const contacts = await client.getContacts();

        const filtered = contacts
            .filter(c => c.isWAContact && c.id.server !== "lid" && !c.isBusiness)
            .map(c => ({ id: c.id._serialized, name: c.name ?? c.pushname ?? c.id.user }))
            .filter(c => c.name.toLowerCase().includes(searchTerm.toLowerCase()));

        const { page, pageSize } = parsePagination(pageRaw, pageSizeRaw);
        const start = page * pageSize;

        return {
            status: 200,
            data: { contacts: filtered.slice(start, start + pageSize), count: filtered.length }
        };

    } catch (error) {
        console.error(error);
        return { status: 500, data: { error: error.message } };
    }
}

async function uploadMedia(media, sender, receiver) {
    try {
        const client = clients[sender.replace("@c.us", "")];
        if (!client)
            return { status: 401, data: { statusCode: '002', statusDesc: 'User session not found' } };

        let fileExt, fileExtTarget, msg, chatType;

        if (media.mimetype === 'audio/mpeg') {
            fileExt = '.mp3'; fileExtTarget = '.ogg'; msg = 'Audio sent'; chatType = 'audio';
        } else if (media.mimetype === 'video/mp4') {
            fileExt = '.mp4'; fileExtTarget = '.mp4'; msg = 'Video sent'; chatType = 'video';
        } else if (media.mimetype === 'image/jpeg') {
            fileExt = '.jpg'; fileExtTarget = '.jpg'; msg = 'Image sent'; chatType = 'image';
        } else {
            return { status: 400, data: { statusCode: '004', statusDesc: 'Unsupported media type' } };
        }

        const senderAddr   = normalizeAddr(sender);
        const receiverAddr = normalizeAddr(receiver);

        const newId      = Date.now(); // Use timestamp as ID for media files
        const srcPath    = path.join(MEDIA_DIR, newId + fileExt);
        const targetPath = path.join(MEDIA_DIR, newId + fileExtTarget);

        fs.writeFileSync(srcPath, Buffer.from(media.data, 'binary'));

        if (media.mimetype === 'audio/mpeg') {
            await ffmpegPromise(srcPath, targetPath, ['-c:a libopus', '-b:a 128k']);
            fs.unlinkSync(srcPath);
            console.log("Audio upload conversion finished");
        }

        const mediaObject = MessageMedia.fromFilePath(targetPath);
        const sentMsg = await client.sendMessage(receiver, mediaObject);
        const waId = sentMsg?.id?._serialized || null;

        // Insert into chats and messages with media_filename
        const contactName = await resolveContactName(client, receiverAddr);

        await getDb().run(`DELETE FROM chats WHERE sender = ?`, [receiverAddr]);
        await getDb().run(
            `INSERT INTO chats(sender, receiver, message, status, sender_name, chat_type, device_type, unread_count)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
            [receiverAddr, senderAddr, msg, 0, contactName, chatType, 'android', 0]
        );

        const result = await getDb().run(
            `INSERT INTO messages(sender, receiver, message, status, sender_name, chat_type, device_type, wa_id, media_filename)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [senderAddr, receiverAddr, msg, 0, client.info.pushname, chatType, 'android', waId, newId + fileExtTarget]
        );

        return { status: 200, data: { statusCode: '000', statusDesc: 'media uploaded successfully' } };

    } catch (error) {
        console.error(error);
        return { status: 500, data: { statusCode: '003', statusDesc: error.message } };
    }
}

// Resuelve el nombre de un contacto a partir de su dirección WA.
// Intenta primero la API de WA; si falla, busca en la BD un mensaje previo del contacto.
async function resolveContactName(client, addr) {
    try {
        const contact = await client.getContactById(addr);
        const name = contact.name || contact.pushname;
        if (name) return name;
    } catch (_) {}

    // Fallback: nombre guardado en mensajes previos recibidos de este contacto
    try {
        const row = await getDb().get(
            `SELECT sender_name FROM messages WHERE sender = ? AND sender_name IS NOT NULL LIMIT 1`,
            [addr]
        );
        if (row?.sender_name) return row.sender_name;
    } catch (_) {}

    return addr; // último recurso: el número en bruto
}

async function getProfilePic(mobileNumber, contactId) {
    try {
        const regex = /;interface=wifi/gi;
        mobileNumber = mobileNumber.replace(regex, "");
        const userId = mobileNumber.replace("@c.us", "");

        console.log(`[profilepic] STEP 1: buscando cliente para usuario: ${userId}`);
        const client = clients[userId];
        if (!client) {
            console.log(`[profilepic] STEP 1 FAIL: cliente no encontrado para: ${userId}`);
            return { status: 401 };
        }
        console.log(`[profilepic] STEP 1 OK: cliente encontrado`);

        const cacheKey  = contactId.replace(/[^a-zA-Z0-9]/g, '_') + '.jpg';
        const cachePath = path.join(PICS_CACHE_DIR, cacheKey);

        // Cache check
        console.log(`[profilepic] STEP 2: checando caché: ${cacheKey}`);
        try {
            const stat = fs.statSync(cachePath);
            if (Date.now() - stat.mtimeMs < PICS_CACHE_TTL) {
                console.log(`[profilepic] STEP 2 OK: foto en caché (${(stat.size/1024).toFixed(1)}KB)`);
                return { status: 200, buffer: fs.readFileSync(cachePath), contentType: 'image/jpeg' };
            }
            console.log(`[profilepic] STEP 2: caché expirado`);
        } catch (e) {
            console.log(`[profilepic] STEP 2: caché miss (${e.message})`);
        }

        // Obtener URL de foto desde la API de WA
        console.log(`[profilepic] STEP 3: llamando getProfilePicUrl(${contactId})`);
        let url = null;
        try {
            url = await client.getProfilePicUrl(contactId);
            if (url) {
                console.log(`[profilepic] STEP 3 OK: URL obtenida (${url.substring(0, 60)}...)`);
            } else {
                console.log(`[profilepic] STEP 3: getProfilePicUrl devolvió null/undefined`);
            }
        } catch (err) {
            console.error(`[profilepic] STEP 3 ERROR: ${err.name}: ${err.message}`);
            console.error(`[profilepic] STEP 3 Stack:`, err.stack);
        }

        // Fallback: @lid → número de teléfono
        if (!url && contactId.includes('@lid')) {
            console.log(`[profilepic] STEP 4: intentando fallback @lid → @c.us`);
            try {
                const contact = await client.getContactById(contactId);
                console.log(`[profilepic] STEP 4: contacto obtenido:`, contact?.number ? 'sí' : 'no');
                if (contact?.number) {
                    const phoneAddr = contact.number + '@c.us';
                    console.log(`[profilepic] STEP 4: llamando getProfilePicUrl(${phoneAddr})`);
                    url = await client.getProfilePicUrl(phoneAddr);
                    if (url) {
                        console.log(`[profilepic] STEP 4 OK: URL obtenida via fallback`);
                    } else {
                        console.log(`[profilepic] STEP 4: fallback devolvió null`);
                    }
                }
            } catch (err) {
                console.error(`[profilepic] STEP 4 ERROR: ${err.name}: ${err.message}`);
            }
        }

        if (!url) {
            console.log(`[profilepic] FAIL: No URL disponible para ${contactId} (probablemente privacidad o no guardado)`);
            return { status: 404 };
        }

        // Descargar y cachear
        console.log(`[profilepic] STEP 5: descargando imagen...`);
        try {
            const response = await fetch(url);
            if (!response.ok) {
                console.error(`[profilepic] STEP 5 ERROR: HTTP ${response.status}`);
                return { status: 404 };
            }

            const buffer      = Buffer.from(await response.arrayBuffer());
            const contentType = response.headers.get('content-type') || 'image/jpeg';

            console.log(`[profilepic] STEP 5 OK: imagen descargada (${(buffer.length/1024).toFixed(1)}KB)`);

            try {
                fs.writeFileSync(cachePath, buffer);
                console.log(`[profilepic] OK FINAL: foto cacheada para ${contactId}`);
            } catch (e) {
                console.error(`[profilepic] ERROR guardando caché: ${e.message}`);
            }

            return { status: 200, buffer, contentType };
        } catch (err) {
            console.error(`[profilepic] STEP 5 ERROR descargando: ${err.message}`);
            return { status: 404 };
        }

    } catch (error) {
        console.error(`[profilepic] ERROR CRÍTICO:`, error.name, error.message);
        console.error(error.stack);
        return { status: 404 };
    }
}

// Sincroniza el historial de mensajes de WhatsApp a la BD local al arrancar el cliente.
// Usa wa_id para deduplicar y evitar duplicados en reinicios.
async function syncHistory(id) {
    const client = clients[id];
    if (!client?.info) return;

    const myAddr = client.info.wid.user + '@c.us';
    console.log(`[${id}] Iniciando sync de historial...`);

    try {
        const waChats = await client.getChats();

        for (const waChat of waChats.slice(0, 30)) {
            try {
                const contactAddr = waChat.id._serialized;
                const contactName = waChat.name || contactAddr;
                const messages = await waChat.fetchMessages({ limit: 50 });

                let lastMsg = null;

                for (const msg of messages) {
                    if (msg.from === 'status@broadcast') continue;

                    const waId = msg.id?._serialized;
                    if (!waId) continue;

                    // Saltar si ya está en BD
                    const exists = await getDb().get(
                        `SELECT _id FROM messages WHERE wa_id = ?`, [waId]
                    );
                    if (exists) { lastMsg = msg; continue; }

                    const sender     = msg.fromMe ? myAddr : normalizeAddr(msg.from);
                    const receiver   = msg.fromMe ? normalizeAddr(msg.to) : myAddr;
                    const senderName = msg.fromMe
                        ? (client.info.pushname || 'Me')
                        : (msg._data?.notifyName || contactName);
                    const msgText    = msg.type === 'chat' ? (msg.body || '') : `${msg.type} received`;
                    const timestamp  = new Date(msg.timestamp * 1000)
                        .toISOString().replace('T', ' ').substring(0, 19);

                    await getDb().run(
                        `INSERT INTO messages
                         (sender, receiver, message, status, sender_name, chat_type, device_type, wa_id, timestamp)
                         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [sender, receiver, msgText, 0, senderName, msg.type || 'chat', 'history', waId, timestamp]
                    );
                    lastMsg = msg;
                }

                // Actualizar chats con el último mensaje del contacto
                if (lastMsg) {
                    const msgText   = lastMsg.type === 'chat' ? (lastMsg.body || '') : `${lastMsg.type} received`;
                    const timestamp = new Date(lastMsg.timestamp * 1000)
                        .toISOString().replace('T', ' ').substring(0, 19);

                    const existing = await getDb().get(
                        `SELECT _id FROM chats WHERE sender = ?`, [contactAddr]
                    );
                    if (!existing) {
                        await getDb().run(
                            `INSERT INTO chats
                             (sender, receiver, message, status, sender_name, chat_type, device_type, timestamp)
                             VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
                            [contactAddr, myAddr, msgText, 0, contactName, lastMsg.type || 'chat', 'history', timestamp]
                        );
                    }
                }

            } catch (chatErr) {
                // Continuar con el siguiente chat si uno falla
            }
        }
        console.log(`[${id}] Sync de historial completado.`);
    } catch (err) {
        console.error(`[${id}] syncHistory error:`, err.message);
    }
}

async function sendMessage(sender, receiver, message) {
    try {
        const client = clients[sender.replace("@c.us", "")];
        if (!client)
            return { status: 401, data: { statusCode: '002', statusDesc: 'User session not found' } };

        // Guardar wa_id del mensaje enviado para deduplicar con message_create
        const sentMsg = await client.sendMessage(receiver, message);
        const waId = sentMsg?.id?._serialized || null;

        // Don't insert into chats table here — message_create event will handle it
        // This prevents duplicate chats when messages are sent
        return { status: 200, data: { message: 'message sent successfully' } };

    } catch (error) {
        const firstLine = error.message.split(/\r?\n/)[0];
        console.error(firstLine);
        return { status: 500, data: { error: firstLine } };
    }
}

async function listUsers() {
    let html = "<style>table,th,td{border:1px solid black;border-collapse:collapse;padding:4px}</style>";
    html += "<table><tr><th>User</th><th>Platform</th></tr>";
    for (const userId in clients) {
        const c = clients[userId];
        html += `<tr><td>${c.info?.pushname ?? ""}</td><td>${c.info?.platform ?? ""}</td></tr>`;
    }
    html += "</table>";
    return html;
}

function clientExists(id) {
    return clients[id] !== undefined;
}

async function getContactInfo(mobileNumber, contactId) {
    try {
        const regex = /;interface=wifi/gi;
        mobileNumber = mobileNumber.replace(regex, "");
        const client = clients[mobileNumber.replace("@c.us", "")];
        if (!client) return { status: 401, data: { error: "User session not found" } };

        let name = "", phone = "", about = "";

        try {
            const contact = await client.getContactById(contactId);
            if (contact) {
                name  = contact.name || contact.pushname || "";
                phone = contact.number ? `+${contact.number}` : "";
                try { about = await contact.getAbout() || ""; } catch (_) {}
            }
        } catch (_) {
            // @lid o contacto no disponible
        }

        // Fallback: extraer número del formato @c.us
        if (!phone && contactId.includes('@c.us')) {
            phone = `+${contactId.replace('@c.us', '')}`;
        }

        return { status: 200, data: { name, phone, about } };
    } catch (error) {
        return { status: 500, data: { error: error.message } };
    }
}

module.exports = {
    startClient, clientExists, sendMessage, getStatus, validate,
    getAllChats, getAllMessages, loginUser, logoutUser,
    getChats, getContacts, uploadMedia, getMessages, listUsers,
    getProfilePic, getContactInfo
}
