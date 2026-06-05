const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const fs = require("fs");

let db;

async function initializeDatabase() {
    const dataPath = `${__dirname}/data`;

    try {
        if (!fs.existsSync(dataPath)) {
            fs.mkdirSync(dataPath);
            console.log(`Folder '${dataPath}' created successfully.`);
        } else {
            console.log(`Folder '${dataPath}' already exists.`);
        }
    } catch (err) {
        console.log('Error creating data folder:', err);
        process.exit(1);
    }

    db = await open({
        filename: './data/mydata.db',
        driver: sqlite3.Database
    });
    console.log(`connected to database.`)

    await db.exec(`CREATE TABLE IF NOT EXISTS users (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL,
        pushname TEXT NOT NULL,
        user TEXT NOT NULL,
        platform TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log(`users table created.`);

    await db.exec(`CREATE TABLE IF NOT EXISTS chats (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        message TEXT NOT NULL,
        status INTEGER DEFAULT 0,
        sender_name TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        device_type TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log(`chats table created.`);

    await db.exec(`CREATE TABLE IF NOT EXISTS messages (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        message TEXT NOT NULL,
        status INTEGER DEFAULT 0,
        sender_name TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        device_type TEXT NOT NULL,
        media_filename TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log(`messages table created.`);

    // Migrations
    try { await db.exec(`ALTER TABLE messages ADD COLUMN media_filename TEXT`); } catch (_) {}
    try {
        await db.exec(`ALTER TABLE messages ADD COLUMN wa_id TEXT`);
        console.log(`messages: columna wa_id añadida.`);
    } catch (_) {}
    try {
        await db.exec(`ALTER TABLE chats ADD COLUMN unread_count INTEGER DEFAULT 0`);
        console.log(`chats: columna unread_count añadida.`);
    } catch (_) {}
    try {
        // Dirección del último mensaje del chat: 1 = lo envié yo, 0 = lo recibí.
        // Permite a la app no notificar mensajes enviados desde otros dispositivos.
        await db.exec(`ALTER TABLE chats ADD COLUMN last_from_me INTEGER DEFAULT 0`);
        console.log(`chats: columna last_from_me añadida.`);
    } catch (_) {}
    try {
        // Emoji de la reacción sobre este mensaje ('' o NULL = sin reacción).
        // Se actualiza vía el evento message_reaction y al reaccionar desde la app.
        await db.exec(`ALTER TABLE messages ADD COLUMN reaction TEXT`);
        console.log(`messages: columna reaction añadida.`);
    } catch (_) {}
    try {
        // Cita (reply): texto y autor del mensaje al que este responde.
        await db.exec(`ALTER TABLE messages ADD COLUMN quoted_message TEXT`);
        await db.exec(`ALTER TABLE messages ADD COLUMN quoted_author TEXT`);
        console.log(`messages: columnas quoted_message/quoted_author añadidas.`);
    } catch (_) {}

    // Indexes
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_chats_receiver  ON chats(receiver)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_chats_sender    ON chats(sender)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conv   ON messages(receiver, sender)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conv2  ON messages(sender, receiver)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_wa_id  ON messages(wa_id)`);
    console.log(`indexes ready.`);
}

module.exports = {
    db: () => db,
    initializeDatabase
}
