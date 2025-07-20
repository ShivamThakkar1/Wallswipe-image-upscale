const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const cron = require('node-cron');

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_USERNAME = '@WallSwipe';
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;

// MongoDB connection
mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => {
    console.log('📊 Connected to MongoDB');
}).catch((error) => {
    console.error('❌ MongoDB connection error:', error);
});

// User Schema
const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    joinDate: { type: Date, default: Date.now },
    lastActivity: { type: Date, default: Date.now },
    totalImagesProcessed: { type: Number, default: 0 },
    preferredQuality: { type: String, default: 'basic' },
    isActive: { type: Boolean, default: true }
}, {
    timestamps: true
});

// Daily Stats Schema
const dailyStatsSchema = new mongoose.Schema({
    date: { type: Date, required: true, unique: true },
    newUsers: { type: Number, default: 0 },
    activeUsers: { type: Number, default: 0 },
    totalImages: { type: Number, default: 0 },
    qualityBreakdown: {
        basic: { type: Number, default: 0 },
        premium: { type: Number, default: 0 },
        elite: { type: Number, default: 0 },
        pro: { type: Number, default: 0 }
    },
    commands: {
        start: { type: Number, default: 0 },
        quality: { type: Number, default: 0 },
        help: { type: Number, default: 0 },
        privacy: { type: Number, default: 0 }
    }
}, {
    timestamps: true
});

// Image Processing Schema
const imageProcessingSchema = new mongoose.Schema({
    userId: { type: Number, required: true },
    quality: { type: String, required: true },
    processedAt: { type: Date, default: Date.now },
    success: { type: Boolean, default: true },
    fileSize: { type: Number, default: 0 },
    processingTime: { type: Number, default: 0 } // in milliseconds
}, {
    timestamps: true
});

const User = mongoose.model('User', userSchema);
const DailyStats = mongoose.model('DailyStats', dailyStatsSchema);
const ImageProcessing = mongoose.model('ImageProcessing', imageProcessingSchema);

// Create bot instance
const bot = new TelegramBot(BOT_TOKEN, { 
    polling: process.env.NODE_ENV !== 'production',
    webHook: process.env.NODE_ENV === 'production' 
});

// For Render deployment - set webhook
if (process.env.NODE_ENV === 'production') {
    const url = process.env.RENDER_EXTERNAL_URL || `https://${process.env.RENDER_SERVICE_SLUG}.onrender.com`;
    bot.setWebHook(`${url}/bot${BOT_TOKEN}`);
    
    // Express server for webhook
    const express = require('express');
    const app = express();
    app.use(express.json());
    
    app.post(`/bot${BOT_TOKEN}`, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
    
    app.get('/', (req, res) => {
        res.send('WallSwipe Image Upscaler Bot is running!');
    });
    
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

// Level mapping
const levelMap = {
    'basic': '1',
    'premium': '2', 
    'elite': '3',
    'pro': '4'
};

// Track if user has seen privacy policy
if (!global.privacyShown) global.privacyShown = new Set();

// Helper function to get or create user
async function getOrCreateUser(userInfo) {
    try {
        let user = await User.findOne({ userId: userInfo.id });
        
        if (!user) {
            user = new User({
                userId: userInfo.id,
                username: userInfo.username || null,
                firstName: userInfo.first_name || null,
                lastName: userInfo.last_name || null,
                joinDate: new Date(),
                lastActivity: new Date(),
                isActive: true
            });
            await user.save();
            
            // Update daily stats for new user
            await updateDailyStats('newUsers', 1);
            
            console.log(`📊 New user registered: ${userInfo.username || userInfo.first_name} (${userInfo.id})`);
        } else {
            // Update last activity and user info
            user.lastActivity = new Date();
            user.username = userInfo.username || user.username;
            user.firstName = userInfo.first_name || user.firstName;
            user.lastName = userInfo.last_name || user.lastName;
            user.isActive = true;
            await user.save();
        }
        
        // Track active user for today
        await updateDailyStats('activeUsers', 1, true); // true for unique count
        
        return user;
    } catch (error) {
        console.error('Error in getOrCreateUser:', error);
        return null;
    }
}

// Helper function to update daily stats
async function updateDailyStats(field, increment = 1, unique = false) {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        let dailyStats = await DailyStats.findOne({ date: today });
        
        if (!dailyStats) {
            dailyStats = new DailyStats({
                date: today,
                newUsers: 0,
                activeUsers: 0,
                totalImages: 0,
                qualityBreakdown: { basic: 0, premium: 0, elite: 0, pro: 0 },
                commands: { start: 0, quality: 0, help: 0, privacy: 0 }
            });
        }
        
        // Handle nested fields
        if (field.includes('.')) {
            const [parent, child] = field.split('.');
            if (!dailyStats[parent]) dailyStats[parent] = {};
            dailyStats[parent][child] = (dailyStats[parent][child] || 0) + increment;
        } else {
            if (unique && field === 'activeUsers') {
                // For active users, we'll handle this differently to avoid double counting
                // This is simplified - in production, you might want to track unique users differently
                dailyStats[field] = Math.max(dailyStats[field] || 0, increment);
            } else {
                dailyStats[field] = (dailyStats[field] || 0) + increment;
            }
        }
        
        await dailyStats.save();
    } catch (error) {
        console.error('Error updating daily stats:', error);
    }
}

// Check if user is in channel
async function checkChannelMembership(userId) {
    try {
        const member = await bot.getChatMember(CHANNEL_USERNAME, userId);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (error) {
        console.error('Error checking channel membership:', error);
        return false;
    }
}

// Send channel join message
function sendChannelJoinMessage(chatId) {
    const keyboard = {
        inline_keyboard: [[
            { text: '📢 Join Channel', url: `https://t.me/${CHANNEL_USERNAME.replace('@', '')}` },
            { text: '✅ Check Again', callback_data: 'check_membership' }
        ]]
    };
    
    bot.sendMessage(chatId, 
        `🔒 To use this bot for FREE, you must join our channel first!\n\n` +
        `📢 Channel: ${CHANNEL_USERNAME}\n\n` +
        `After joining, click "Check Again" to continue.`, 
        { reply_markup: keyboard }
    );
}

// Generate stats report
async function generateStatsReport(type = 'daily') {
    try {
        const now = new Date();
        let startDate, endDate, title;
        
        if (type === 'daily') {
            startDate = new Date(now);
            startDate.setDate(startDate.getDate() - 1);
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(startDate);
            endDate.setHours(23, 59, 59, 999);
            title = `📊 Daily Stats Report - ${startDate.toDateString()}`;
        } else if (type === 'monthly') {
            startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
            title = `📈 Monthly Stats Report - ${startDate.toLocaleString('default', { month: 'long', year: 'numeric' })}`;
        }
        
        // Get daily stats for the period
        const dailyStats = await DailyStats.find({
            date: { $gte: startDate, $lte: endDate }
        }).sort({ date: 1 });
        
        // Get total users
        const totalUsers = await User.countDocuments({});
        const newUsers = dailyStats.reduce((sum, day) => sum + day.newUsers, 0);
        const totalImages = dailyStats.reduce((sum, day) => sum + day.totalImages, 0);
        
        // Get active users in period
        const activeUsers = await User.countDocuments({
            lastActivity: { $gte: startDate, $lte: endDate }
        });
        
        // Quality breakdown
        const qualityStats = {
            basic: dailyStats.reduce((sum, day) => sum + (day.qualityBreakdown?.basic || 0), 0),
            premium: dailyStats.reduce((sum, day) => sum + (day.qualityBreakdown?.premium || 0), 0),
            elite: dailyStats.reduce((sum, day) => sum + (day.qualityBreakdown?.elite || 0), 0),
            pro: dailyStats.reduce((sum, day) => sum + (day.qualityBreakdown?.pro || 0), 0)
        };
        
        // Command usage
        const commandStats = {
            start: dailyStats.reduce((sum, day) => sum + (day.commands?.start || 0), 0),
            quality: dailyStats.reduce((sum, day) => sum + (day.commands?.quality || 0), 0),
            help: dailyStats.reduce((sum, day) => sum + (day.commands?.help || 0), 0),
            privacy: dailyStats.reduce((sum, day) => sum + (day.commands?.privacy || 0), 0)
        };
        
        // Get top users (most images processed)
        const topUsers = await User.find({})
            .sort({ totalImagesProcessed: -1 })
            .limit(5)
            .select('username firstName totalImagesProcessed');
        
        // Format report
        let report = `${title}\n\n`;
        report += `👥 **User Statistics:**\n`;
        report += `• Total Users: ${totalUsers}\n`;
        report += `• New Users: ${newUsers}\n`;
        report += `• Active Users: ${activeUsers}\n\n`;
        
        report += `🖼️ **Image Processing:**\n`;
        report += `• Total Images: ${totalImages}\n\n`;
        
        report += `⚙️ **Quality Breakdown:**\n`;
        report += `• 🔧 Basic: ${qualityStats.basic}\n`;
        report += `• ⭐ Premium: ${qualityStats.premium}\n`;
        report += `• 💎 Elite: ${qualityStats.elite}\n`;
        report += `• 🚀 Pro: ${qualityStats.pro}\n\n`;
        
        report += `📱 **Command Usage:**\n`;
        report += `• /start: ${commandStats.start}\n`;
        report += `• /quality: ${commandStats.quality}\n`;
        report += `• /help: ${commandStats.help}\n`;
        report += `• /privacy: ${commandStats.privacy}\n\n`;
        
        if (topUsers.length > 0) {
            report += `🏆 **Top Users:**\n`;
            topUsers.forEach((user, index) => {
                const name = user.username ? `@${user.username}` : user.firstName || 'Anonymous';
                report += `${index + 1}. ${name}: ${user.totalImagesProcessed} images\n`;
            });
        }
        
        report += `\n📌 Powered by @WallSwipe`;
        
        return report;
    } catch (error) {
        console.error('Error generating stats report:', error);
        return `❌ Error generating ${type} report: ${error.message}`;
    }
}

// Send stats to admin
async function sendStatsToAdmin(type = 'daily') {
    if (!ADMIN_USER_ID) {
        console.log('⚠️ Admin user ID not set, skipping stats report');
        return;
    }
    
    try {
        const report = await generateStatsReport(type);
        await bot.sendMessage(ADMIN_USER_ID, report, { parse_mode: 'Markdown' });
        console.log(`📊 ${type} stats sent to admin`);
    } catch (error) {
        console.error(`Error sending ${type} stats to admin:`, error);
    }
}

// Schedule daily stats (every day at 9:00 AM)
cron.schedule('0 9 * * *', () => {
    console.log('📊 Sending daily stats report...');
    sendStatsToAdmin('daily');
}, {
    timezone: "UTC"
});

// Schedule monthly stats (1st of every month at 10:00 AM)
cron.schedule('0 10 1 * *', () => {
    console.log('📈 Sending monthly stats report...');
    sendStatsToAdmin('monthly');
}, {
    timezone: "UTC"
});

// Admin command to get stats on demand
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (userId.toString() !== ADMIN_USER_ID) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only command.');
        return;
    }
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '📊 Daily Stats', callback_data: 'admin_daily_stats' }],
            [{ text: '📈 Monthly Stats', callback_data: 'admin_monthly_stats' }],
            [{ text: '👥 User Export', callback_data: 'admin_export_users' }]
        ]
    };
    
    bot.sendMessage(chatId, '📊 Choose stats type:', { reply_markup: keyboard });
});

// Start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Track user and command
    await getOrCreateUser(msg.from);
    await updateDailyStats('commands.start');
    
    // Show privacy policy only for first-time users
    if (!global.privacyShown.has(userId)) {
        const privacyMessage = `📄 **Privacy Policy:**
When you use this bot, your images are sent to third-party AI services (e.g., image upscaling APIs) to process and return enhanced results.
These third-party services **may temporarily store or analyze** the image data as part of their operation. We do not control how third-party APIs handle data, and by using this bot, you consent to their data handling practices.
We do **not collect or store** your personal information (e.g., names, usernames, chats). Images are not saved on our servers and are processed only to deliver the result.
By using this bot, you agree to this data processing and you accept the Telegram Bot Standard Privacy Policy:
🔗 https://telegram.org/privacy-tpa
📌 Powered by @WallSwipe

━━━━━━━━━━━━━━━━━━━━━━━━━`;
        
        await bot.sendMessage(chatId, privacyMessage, { parse_mode: 'Markdown' });
        global.privacyShown.add(userId);
    }
    
    const isMember = await checkChannelMembership(userId);
    
    if (!isMember) {
        sendChannelJoinMessage(chatId);
        return;
    }
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '🔧 Basic', callback_data: 'scale_basic' }],
            [{ text: '⭐ Premium', callback_data: 'scale_premium' }],
            [{ text: '💎 Elite', callback_data: 'scale_elite' }],
            [{ text: '🚀 Pro', callback_data: 'scale_pro' }]
        ]
    };
    
    bot.sendMessage(chatId, 
        `🖼️ Welcome to WallSwipe Image Upscaler!\n\n` +
        `Choose your upscale quality and send me an image:`, 
        { reply_markup: keyboard }
    );
});

// Quality selection command
bot.onText(/\/quality/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    await getOrCreateUser(msg.from);
    await updateDailyStats('commands.quality');
    
    const isMember = await checkChannelMembership(userId);
    
    if (!isMember) {
        sendChannelJoinMessage(chatId);
        return;
    }
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '🔧 Basic', callback_data: 'scale_basic' }],
            [{ text: '⭐ Premium', callback_data: 'scale_premium' }],
            [{ text: '💎 Elite', callback_data: 'scale_elite' }],
            [{ text: '🚀 Pro', callback_data: 'scale_pro' }]
        ]
    };
    
    bot.sendMessage(chatId, 
        `🖼️ Choose your upscale quality:`, 
        { reply_markup: keyboard }
    );
});

// Privacy command
bot.onText(/\/privacy/, async (msg) => {
    const chatId = msg.chat.id;
    
    await getOrCreateUser(msg.from);
    await updateDailyStats('commands.privacy');
    
    const privacyMessage = `📄 **Privacy Policy:**
When you use this bot, your images are sent to third-party AI services (e.g., image upscaling APIs) to process and return enhanced results.
These third-party services **may temporarily store or analyze** the image data as part of their operation. We do not control how third-party APIs handle data, and by using this bot, you consent to their data handling practices.
We do **not collect or store** your personal information (e.g., names, usernames, chats). Images are not saved on our servers and are processed only to deliver the result.
By using this bot, you agree to this data processing and you accept the Telegram Bot Standard Privacy Policy:
🔗 https://telegram.org/privacy-tpa
📌 Powered by @WallSwipe`;
    
    bot.sendMessage(chatId, privacyMessage, { parse_mode: 'Markdown' });
});

// Help command
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    await getOrCreateUser(msg.from);
    await updateDailyStats('commands.help');
    
    const helpMessage = `🤖 **WallSwipe Image Upscaler Bot Help**

**How to use:**
1️⃣ Use /start to begin
2️⃣ Join our channel @WallSwipe (required for free use)
3️⃣ Select upscale quality (Basic, Premium, Elite, Pro)
4️⃣ Send any image to upscale
5️⃣ Receive your enhanced image!

**Available Commands:**
• /start - Start the bot and show quality options
• /quality - Change upscale quality anytime
• /help - Show this help message
• /privacy - View privacy policy

**Upscale Qualities:**
🔧 **Basic** - Standard quality enhancement
⭐ **Premium** - Better quality with more details
💎 **Elite** - High-quality enhancement
🚀 **Pro** - Maximum quality upscaling

**Supported Formats:**
✅ JPG, JPEG, PNG images
✅ Send as photo or document
✅ Any image size

**Requirements:**
📢 Must join @WallSwipe channel to use for free

📌 Powered by @WallSwipe`;
    
    bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Handle callback queries
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;
    
    await getOrCreateUser(callbackQuery.from);
    
    // Admin callback handlers
    if (data === 'admin_daily_stats' && userId.toString() === ADMIN_USER_ID) {
        const report = await generateStatsReport('daily');
        bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
        bot.answerCallbackQuery(callbackQuery.id);
        return;
    }
    
    if (data === 'admin_monthly_stats' && userId.toString() === ADMIN_USER_ID) {
        const report = await generateStatsReport('monthly');
        bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
        bot.answerCallbackQuery(callbackQuery.id);
        return;
    }
    
    if (data === 'admin_export_users' && userId.toString() === ADMIN_USER_ID) {
        try {
            const users = await User.find({}).select('userId username firstName lastName joinDate lastActivity totalImagesProcessed');
            let exportData = `👥 **User Export** (${users.length} users)\n\n`;
            
            users.forEach((user, index) => {
                const name = user.username ? `@${user.username}` : `${user.firstName || 'Anonymous'}`;
                const joinDate = user.joinDate.toDateString();
                const lastActivity = user.lastActivity.toDateString();
                exportData += `${index + 1}. ${name} (${user.userId})\n`;
                exportData += `   Joined: ${joinDate}\n`;
                exportData += `   Last Active: ${lastActivity}\n`;
                exportData += `   Images: ${user.totalImagesProcessed}\n\n`;
            });
            
            // Split message if too long
            const maxLength = 4000;
            if (exportData.length > maxLength) {
                const chunks = exportData.match(new RegExp(`.{1,${maxLength}}`, 'g'));
                for (let chunk of chunks) {
                    await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
                }
            } else {
                bot.sendMessage(chatId, exportData, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            bot.sendMessage(chatId, `❌ Error exporting users: ${error.message}`);
        }
        bot.answerCallbackQuery(callbackQuery.id);
        return;
    }
    
    if (data === 'check_membership') {
        const isMember = await checkChannelMembership(userId);
        
        if (isMember) {
            bot.editMessageText(
                `✅ Great! You're now a member. Choose your upscale quality:`,
                {
                    chat_id: chatId,
                    message_id: callbackQuery.message.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔧 Basic', callback_data: 'scale_basic' }],
                            [{ text: '⭐ Premium', callback_data: 'scale_premium' }],
                            [{ text: '💎 Elite', callback_data: 'scale_elite' }],
                            [{ text: '🚀 Pro', callback_data: 'scale_pro' }]
                        ]
                    }
                }
            );
        } else {
            bot.answerCallbackQuery(callbackQuery.id, {
                text: '❌ You still need to join the channel first!',
                show_alert: true
            });
        }
        return;
    }
    
    if (data.startsWith('scale_')) {
        const level = data.replace('scale_', '');
        
        // Store user's choice in memory and database
        if (!global.userChoices) global.userChoices = {};
        global.userChoices[userId] = level;
        
        // Update user's preferred quality in database
        try {
            await User.findOneAndUpdate(
                { userId: userId },
                { preferredQuality: level },
                { upsert: true }
            );
        } catch (error) {
            console.error('Error updating user preference:', error);
        }
        
        bot.editMessageText(
            `✅ Selected: ${level.toUpperCase()}\n\n📸 Now send me an image to upscale!`,
            {
                chat_id: chatId,
                message_id: callbackQuery.message.message_id
            }
        );
    }
    
    bot.answerCallbackQuery(callbackQuery.id);
});

// Handle photo uploads
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const startTime = Date.now();
    
    // Track user
    await getOrCreateUser(msg.from);
    
    // Check channel membership
    const isMember = await checkChannelMembership(userId);
    
    if (!isMember) {
        sendChannelJoinMessage(chatId);
        return;
    }
    
    // Check if user has selected a scale level
    if (!global.userChoices || !global.userChoices[userId]) {
        const keyboard = {
            inline_keyboard: [
                [{ text: '🔧 Basic', callback_data: 'scale_basic' }],
                [{ text: '⭐ Premium', callback_data: 'scale_premium' }],
                [{ text: '💎 Elite', callback_data: 'scale_elite' }],
                [{ text: '🚀 Pro', callback_data: 'scale_pro' }]
            ]
        };
        
        bot.sendMessage(chatId, 
            `⚠️ Please select upscale quality first:`, 
            { reply_markup: keyboard }
        );
        return;
    }
    
    const selectedLevel = global.userChoices[userId];
    const scaleValue = levelMap[selectedLevel];
    
    try {
        const statusMsg = await bot.sendMessage(chatId, '📤 Uploading image...');
        
        // Get the highest resolution photo
        const photo = msg.photo[msg.photo.length - 1];
        const fileLink = await bot.getFileLink(photo.file_id);
        
        // Download image
        const response = await axios.get(fileLink, { responseType: 'stream' });
        const tempPath = path.join(__dirname, `temp_${userId}_${Date.now()}.jpg`);
        const writer = fs.createWriteStream(tempPath);
        response.data.pipe(writer);
        
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
        // Get file size
        const fileStats = fs.statSync(tempPath);
        const fileSizeKB = Math.round(fileStats.size / 1024);
        
        // Step 1: Upload to upscaler API
        const uploadUrl = "https://photoai.imglarger.com/api/PhoAi/Upload";
        const formData = new FormData();
        formData.append('file', fs.createReadStream(tempPath), {
            filename: 'image.jpg',
            contentType: 'image/jpeg'
        });
        formData.append('type', '2');
        formData.append('scaleRadio', scaleValue);
        
        const uploadHeaders = {
            ...formData.getHeaders(),
            "Origin": "https://image-enhancer-snowy.vercel.app",
            "Referer": "https://image-enhancer-snowy.vercel.app/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
        };
        
        const uploadRes = await axios.post(uploadUrl, formData, { headers: uploadHeaders });
        
        if (uploadRes.data.code !== 200) {
            throw new Error(`Upload failed: ${JSON.stringify(uploadRes.data)}`);
        }
        
        const code = uploadRes.data.data.code;
        const imgType = uploadRes.data.data.type;
        
        bot.editMessageText('⏳ Processing image...', {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
        
        // Step 2: Check status
        const checkUrl = "https://photoai.imglarger.com/api/PhoAi/CheckStatus";
        const payload = {
            code: code,
            type: String(imgType)
        };
        
        const statusHeaders = {
            "Origin": "https://image-enhancer-snowy.vercel.app",
            "Referer": "https://image-enhancer-snowy.vercel.app/",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
        };
        
        let upscaledUrl = null;
        
        for (let attempt = 0; attempt < 20; attempt++) {
            const statusRes = await axios.post(checkUrl, payload, { headers: statusHeaders });
            
            if (statusRes.status !== 200) {
                throw new Error(`Status check failed: ${statusRes.status}`);
            }
            
            const statusData = statusRes.data;
            const status = statusData.data?.status;
            
            if (status === 'success') {
                upscaledUrl = statusData.data.downloadUrls[0];
                break;
            } else if (status === 'waiting') {
                bot.editMessageText(`⌛ Still processing... (${attempt + 1}/20)`, {
                    chat_id: chatId,
                    message_id: statusMsg.message_id
                });
                await new Promise(resolve => setTimeout(resolve, 3000));
            } else {
                throw new Error(`Unknown status: ${JSON.stringify(statusData)}`);
            }
        }
        
        if (!upscaledUrl) {
            throw new Error('Upscale timed out');
        }
        
        bot.editMessageText('📥 Downloading result...', {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
        
        // Step 3: Download and send result
        const imageData = await axios.get(upscaledUrl, { responseType: 'stream' });
        const outputPath = path.join(__dirname, `WallSwipe_${selectedLevel}_${Date.now()}.jpg`);
        const outputWriter = fs.createWriteStream(outputPath);
        imageData.data.pipe(outputWriter);
        
        await new Promise((resolve, reject) => {
            outputWriter.on('finish', resolve);
            outputWriter.on('error', reject);
        });
        
        // Send the upscaled image
        await bot.sendDocument(chatId, outputPath, {
            caption: `✅ Upscaled with ${selectedLevel.toUpperCase()} quality!\n\n🔄 Send another image or use /quality to change quality.`
        }, {
            filename: `WallSwipe_${selectedLevel}.jpg`
        });
        
        // Calculate processing time
        const processingTime = Date.now() - startTime;
        
        // Update user stats
        try {
            await User.findOneAndUpdate(
                { userId: userId },
                { 
                    $inc: { totalImagesProcessed: 1 },
                    lastActivity: new Date()
                }
            );
            
            // Log image processing
            const imageLog = new ImageProcessing({
                userId: userId,
                quality: selectedLevel,
                processedAt: new Date(),
                success: true,
                fileSize: fileSizeKB,
                processingTime: processingTime
            });
            await imageLog.save();
            
            // Update daily stats
            await updateDailyStats('totalImages');
            await updateDailyStats(`qualityBreakdown.${selectedLevel}`);
            
            console.log(`📊 Image processed: User ${userId}, Quality: ${selectedLevel}, Size: ${fileSizeKB}KB, Time: ${processingTime}ms`);
        } catch (error) {
            console.error('Error updating stats:', error);
        }
        
        // Clean up files
        fs.unlinkSync(tempPath);
        fs.unlinkSync(outputPath);
        
        // Delete status message
        bot.deleteMessage(chatId, statusMsg.message_id);
        
    } catch (error) {
        console.error('Error processing image:', error);
        
        // Log failed processing
        try {
            const processingTime = Date.now() - startTime;
            const imageLog = new ImageProcessing({
                userId: userId,
                quality: selectedLevel,
                processedAt: new Date(),
                success: false,
                fileSize: 0,
                processingTime: processingTime
            });
            await imageLog.save();
        } catch (logError) {
            console.error('Error logging failed processing:', logError);
        }
        
        bot.sendMessage(chatId, `❌ Failed to process image: ${error.message}`);
    }
});

// Handle documents (images sent as files)
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    
    if (msg.document.mime_type && msg.document.mime_type.startsWith('image/')) {
        // Convert document to photo-like object and process
        const photoLikeMsg = {
            ...msg,
            photo: [{
                file_id: msg.document.file_id,
                file_size: msg.document.file_size
            }]
        };
        
        // Remove document property to avoid confusion
        delete photoLikeMsg.document;
        
        // Process as photo
        bot.emit('photo', photoLikeMsg);
    } else {
        bot.sendMessage(chatId, '⚠️ Please send an image file (JPG, PNG, etc.)');
    }
});

// Admin command to broadcast message
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (userId.toString() !== ADMIN_USER_ID) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only command.');
        return;
    }
    
    const message = match[1];
    
    try {
        const users = await User.find({ isActive: true }).select('userId');
        let sentCount = 0;
        let failCount = 0;
        
        bot.sendMessage(chatId, `📢 Broadcasting to ${users.length} users...`);
        
        for (const user of users) {
            try {
                await bot.sendMessage(user.userId, message, { parse_mode: 'Markdown' });
                sentCount++;
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 50));
            } catch (error) {
                failCount++;
                if (error.response?.body?.error_code === 403) {
                    // User blocked the bot, mark as inactive
                    await User.findOneAndUpdate(
                        { userId: user.userId },
                        { isActive: false }
                    );
                }
            }
        }
        
        bot.sendMessage(chatId, `✅ Broadcast completed!\n• Sent: ${sentCount}\n• Failed: ${failCount}`);
    } catch (error) {
        bot.sendMessage(chatId, `❌ Broadcast failed: ${error.message}`);
    }
});

// Admin command to get user info
bot.onText(/\/userinfo (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (userId.toString() !== ADMIN_USER_ID) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only command.');
        return;
    }
    
    const targetUserId = parseInt(match[1]);
    
    try {
        const user = await User.findOne({ userId: targetUserId });
        
        if (!user) {
            bot.sendMessage(chatId, '❌ User not found.');
            return;
        }
        
        const recentImages = await ImageProcessing.find({ userId: targetUserId })
            .sort({ processedAt: -1 })
            .limit(5);
        
        let userInfo = `👤 **User Information**\n\n`;
        userInfo += `**ID:** ${user.userId}\n`;
        userInfo += `**Username:** ${user.username ? `@${user.username}` : 'None'}\n`;
        userInfo += `**Name:** ${user.firstName || 'Unknown'} ${user.lastName || ''}\n`;
        userInfo += `**Joined:** ${user.joinDate.toDateString()}\n`;
        userInfo += `**Last Active:** ${user.lastActivity.toDateString()}\n`;
        userInfo += `**Total Images:** ${user.totalImagesProcessed}\n`;
        userInfo += `**Preferred Quality:** ${user.preferredQuality}\n`;
        userInfo += `**Status:** ${user.isActive ? '✅ Active' : '❌ Inactive'}\n\n`;
        
        if (recentImages.length > 0) {
            userInfo += `**Recent Activity:**\n`;
            recentImages.forEach((img, index) => {
                const date = img.processedAt.toLocaleDateString();
                const status = img.success ? '✅' : '❌';
                userInfo += `${index + 1}. ${status} ${img.quality} - ${date}\n`;
            });
        }
        
        bot.sendMessage(chatId, userInfo, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, `❌ Error getting user info: ${error.message}`);
    }
});

// Handle errors
bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

bot.on('webhook_error', (error) => {
    console.error('Webhook error:', error);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down bot...');
    try {
        await mongoose.connection.close();
        console.log('📊 Database connection closed');
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});

// Initialize database indexes for better performance
mongoose.connection.once('open', async () => {
    try {
        await User.collection.createIndex({ userId: 1 }, { unique: true });
        await User.collection.createIndex({ lastActivity: -1 });
        await User.collection.createIndex({ totalImagesProcessed: -1 });
        
        await DailyStats.collection.createIndex({ date: 1 }, { unique: true });
        
        await ImageProcessing.collection.createIndex({ userId: 1 });
        await ImageProcessing.collection.createIndex({ processedAt: -1 });
        
        console.log('📊 Database indexes created successfully');
    } catch (error) {
        console.error('Error creating database indexes:', error);
    }
});

console.log('🤖 WallSwipe Image Upscaler Bot with Stats Tracking started!')
