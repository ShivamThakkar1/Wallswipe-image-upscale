import os
import requests
import time
import json
import logging
from io import BytesIO
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, MessageHandler, CallbackQueryHandler, filters, ContextTypes
import mimetypes

# Configure logging

logging.basicConfig(
format=’%(asctime)s - %(name)s - %(levelname)s - %(message)s’,
level=logging.INFO
)
logger = logging.getLogger(**name**)

# Bot configuration from environment variables

BOT_TOKEN = os.getenv(‘BOT_TOKEN’)
CHANNEL_USERNAME = os.getenv(‘CHANNEL_USERNAME’, ‘@WallSwipe’)
CHANNEL_ID = os.getenv(‘CHANNEL_ID’, ‘@WallSwipe’)  # Can be channel ID like -1001234567890
WEBHOOK_URL = os.getenv(‘WEBHOOK_URL’)  # Full webhook URL

# Level mapping

LEVEL_MAP = {
“basic”: “1”,
“premium”: “2”,
“elite”: “3”,
“pro”: “4”
}

class ImageUpscalerBot:
def **init**(self):
self.app = Application.builder().token(BOT_TOKEN).build()
self.setup_handlers()

```
def setup_handlers(self):
    """Setup bot handlers"""
    self.app.add_handler(CommandHandler("start", self.start))
    self.app.add_handler(CommandHandler("help", self.help_command))
    self.app.add_handler(CallbackQueryHandler(self.button_callback))
    self.app.add_handler(MessageHandler(filters.PHOTO, self.handle_photo))
    self.app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self.handle_text))

async def check_channel_membership(self, user_id: int, context: ContextTypes.DEFAULT_TYPE) -> bool:
    """Check if user is a member of the required channel"""
    try:
        member = await context.bot.get_chat_member(CHANNEL_ID, user_id)
        return member.status in ['member', 'administrator', 'creator']
    except Exception as e:
        logger.error(f"Error checking channel membership: {e}")
        return False

async def send_channel_join_message(self, update: Update):
    """Send message asking user to join channel"""
    channel_link = f"https://t.me/{CHANNEL_USERNAME.replace('@', '')}"
    keyboard = [[InlineKeyboardButton("📢 Join Channel", url=channel_link)]]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    message = (
        f"🔒 **Access Required!**\n\n"
        f"To use this bot for **FREE**, you need to join our wallpaper channel:\n"
        f"{CHANNEL_USERNAME}\n\n"
        f"After joining, come back and try again! 🎨"
    )
    
    await update.message.reply_text(message, reply_markup=reply_markup, parse_mode='Markdown')

async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /start command"""
    user_id = update.effective_user.id
    
    if not await self.check_channel_membership(user_id, context):
        await self.send_channel_join_message(update)
        return
    
    welcome_message = (
        "🖼️ **Welcome to Image Upscaler Bot!**\n\n"
        "Send me any image and I'll upscale it for you!\n\n"
        "**Available Quality Levels:**\n"
        "• Basic - Standard upscaling\n"
        "• Premium - Enhanced quality\n"
        "• Elite - High-end processing\n"
        "• Pro - Maximum quality\n\n"
        "Just send me an image to get started! 📸"
    )
    
    await update.message.reply_text(welcome_message, parse_mode='Markdown')

async def help_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /help command"""
    help_message = (
        "ℹ️ **How to use this bot:**\n\n"
        f"1. Make sure you're joined to {CHANNEL_USERNAME}\n"
        "2. Send me any image\n"
        "3. Choose quality level (Basic/Premium/Elite/Pro)\n"
        "4. Wait for processing\n"
        "5. Download your upscaled image!\n\n"
        "**Commands:**\n"
        "/start - Start the bot\n"
        "/help - Show this help message\n\n"
        "**Support:** Forward any issues to bot admin"
    )
    
    await update.message.reply_text(help_message, parse_mode='Markdown')

async def handle_photo(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle photo messages"""
    user_id = update.effective_user.id
    
    if not await self.check_channel_membership(user_id, context):
        await self.send_channel_join_message(update)
        return
    
    # Store photo for later processing
    context.user_data['photo'] = update.message.photo[-1]  # Get highest resolution
    
    # Create quality selection keyboard
    keyboard = [
        [InlineKeyboardButton("🥉 Basic", callback_data="basic"),
         InlineKeyboardButton("🥈 Premium", callback_data="premium")],
        [InlineKeyboardButton("🥇 Elite", callback_data="elite"),
         InlineKeyboardButton("💎 Pro", callback_data="pro")]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    await update.message.reply_text(
        "📸 **Image received!**\n\nChoose upscaling quality:",
        reply_markup=reply_markup,
        parse_mode='Markdown'
    )

async def button_callback(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle button callbacks"""
    query = update.callback_query
    await query.answer()
    
    user_id = update.effective_user.id
    
    if not await self.check_channel_membership(user_id, context):
        await query.edit_message_text(f"❌ You need to join {CHANNEL_USERNAME} first!")
        return
    
    level = query.data
    if level not in LEVEL_MAP:
        await query.edit_message_text("❌ Invalid quality level selected!")
        return
    
    photo = context.user_data.get('photo')
    if not photo:
        await query.edit_message_text("❌ No image found! Please send an image first.")
        return
    
    await query.edit_message_text(f"⏳ Processing image with **{level.title()}** quality...")
    
    try:
        # Download the image
        file = await context.bot.get_file(photo.file_id)
        image_data = await file.download_as_bytearray()
        
        # Process the image
        result_url = await self.upscale_image(image_data, level)
        
        if result_url:
            # Download upscaled image
            upscaled_response = requests.get(result_url)
            upscaled_data = upscaled_response.content
            
            # Detect file extension from multiple sources
            file_extension = self.detect_file_extension(
                result_url, 
                upscaled_response.headers.get('content-type', ''),
                upscaled_data
            )
            
            # Create filename with format: @wallswipe_userselectedmode.extension
            filename = f"@wallswipe_{level}.{file_extension}"
            
            # Send upscaled image as document (uncompressed)
            await context.bot.send_document(
                chat_id=query.message.chat_id,
                document=BytesIO(upscaled_data),
                filename=filename,
                caption=f"✅ **Image upscaled successfully!**\n\nQuality: {level.title()}\nFormat: {file_extension.upper()}\n\n🔄 Send another image to upscale more!",
                parse_mode='Markdown'
            )
            
            await query.edit_message_text(f"✅ **Done!** Your {level} upscaled image is ready!")
        else:
            await query.edit_message_text("❌ **Failed to upscale image.** Please try again later.")
            
    except Exception as e:
        logger.error(f"Error processing image: {e}")
        await query.edit_message_text("❌ **Error processing image.** Please try again later.")
    
    # Clear stored photo
    context.user_data.pop('photo', None)

def detect_file_extension(self, url: str, content_type: str, image_data: bytes = None) -> str:
    """Detect file extension from URL, content type, or image data"""
    try:
        # Method 1: Try to get extension from URL
        if url:
            # Check if URL has a file extension
            url_parts = url.split('.')
            if len(url_parts) > 1:
                potential_ext = url_parts[-1].lower()
                # Remove query parameters
                potential_ext = potential_ext.split('?')[0].split('&')[0]
                # Check if it's a valid image extension
                if potential_ext in ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff', 'tif']:
                    return potential_ext
        
        # Method 2: Try to get extension from content type
        if content_type:
            content_type = content_type.lower()
            if 'jpeg' in content_type or 'jpg' in content_type:
                return 'jpg'
            elif 'png' in content_type:
                return 'png'
            elif 'gif' in content_type:
                return 'gif'
            elif 'bmp' in content_type:
                return 'bmp'
            elif 'webp' in content_type:
                return 'webp'
            elif 'tiff' in content_type or 'tif' in content_type:
                return 'tiff'
        
        # Method 3: Try to detect from image data (magic bytes)
        if image_data and len(image_data) > 10:
            # Check magic bytes
            if image_data.startswith(b'\xff\xd8\xff'):
                return 'jpg'
            elif image_data.startswith(b'\x89PNG\r\n\x1a\n'):
                return 'png'
            elif image_data.startswith(b'GIF87a') or image_data.startswith(b'GIF89a'):
                return 'gif'
            elif image_data.startswith(b'BM'):
                return 'bmp'
            elif image_data.startswith(b'RIFF') and b'WEBP' in image_data[:12]:
                return 'webp'
            elif image_data.startswith(b'II*\x00') or image_data.startswith(b'MM\x00*'):
                return 'tiff'
        
        # Default to jpg if unable to detect
        return 'jpg'
        
    except Exception as e:
        logger.error(f"Error detecting file extension: {e}")
        return 'jpg'

async def upscale_image(self, image_data: bytes, level: str) -> str:
    """Upscale image using the API"""
    try:
        scale_value = LEVEL_MAP[level]
        
        # Step 1: Upload image
        upload_url = "https://photoai.imglarger.com/api/PhoAi/Upload"
        files = {
            "file": ("image.jpg", BytesIO(image_data), "image/jpeg")
        }
        data = {
            "type": "2",
            "scaleRadio": scale_value
        }
        upload_headers = {
            "Origin": "https://image-enhancer-snowy.vercel.app",
            "Referer": "https://image-enhancer-snowy.vercel.app/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
        }
        
        upload_res = requests.post(upload_url, data=data, files=files, headers=upload_headers)
        upload_json = upload_res.json()
        
        if upload_json.get("code") != 200:
            logger.error(f"Upload failed: {upload_json}")
            return None
        
        code = upload_json["data"]["code"]
        img_type = upload_json["data"]["type"]
        
        # Step 2: Check status
        check_url = "https://photoai.imglarger.com/api/PhoAi/CheckStatus"
        payload = json.dumps({
            "code": code,
            "type": str(img_type)
        })
        status_headers = {
            "Origin": "https://image-enhancer-snowy.vercel.app",
            "Referer": "https://image-enhancer-snowy.vercel.app/",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
        }
        
        # Wait for processing (max 60 seconds)
        for attempt in range(20):
            res = requests.post(check_url, headers=status_headers, data=payload)
            
            if res.status_code != 200:
                logger.error(f"Server error {res.status_code}: {res.text}")
                break
            
            try:
                status_json = res.json()
                status = status_json["data"].get("status")
                
                if status == "success":
                    return status_json["data"]["downloadUrls"][0]
                elif status == "waiting":
                    logger.info(f"Still processing... ({attempt + 1}/20)")
                else:
                    logger.error(f"Unknown status: {status_json}")
                    break
                    
            except Exception as e:
                logger.error(f"Failed to parse CheckStatus response: {e}")
                break
            
            time.sleep(3)
        
        return None
        
    except Exception as e:
        logger.error(f"Error in upscale_image: {e}")
        return None

async def handle_text(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle text messages"""
    user_id = update.effective_user.id
    
    if not await self.check_channel_membership(user_id, context):
        await self.send_channel_join_message(update)
        return
    
    await update.message.reply_text(
        "📸 **Send me an image to upscale!**\n\n"
        "I can enhance any image you send with different quality levels.",
        parse_mode='Markdown'
    )

def run(self):
    """Run the bot"""
    logger.info("Starting Image Upscaler Bot...")
    
    # Get port from environment (for Render deployment)
    port = int(os.environ.get('PORT', 8080))
    
    if os.environ.get('RENDER'):
        # Running on Render - use webhook
        if not WEBHOOK_URL:
            logger.error("WEBHOOK_URL environment variable not set for Render deployment!")
            return
            
        logger.info(f"Setting up webhook at {WEBHOOK_URL}")
        self.app.run_webhook(
            listen="0.0.0.0",
            port=port,
            url_path=BOT_TOKEN,
            webhook_url=WEBHOOK_URL
        )
    else:
        # Running locally - use polling
        logger.info("Running in polling mode (local development)")
        self.app.run_polling(allowed_updates=Update.ALL_TYPES)
```

def main():
“”“Main function”””
if not BOT_TOKEN:
logger.error(“❌ BOT_TOKEN environment variable not set!”)
return

```
logger.info(f"Bot configured with channel: {CHANNEL_USERNAME} (ID: {CHANNEL_ID})")

bot = ImageUpscalerBot()
bot.run()
```

# Auto-start for Render deployment

if **name** == “**main**”:
main()