# 🚀 Customer Support - Deployment Guide

Complete guide for deploying the Customer Support platform to **Render** (backend), **Vercel** (frontend), setting up the **Telegram Bot**, and building the **Android APK**.

---

## 📋 Prerequisites

- GitHub account with repository containing this project
- [Render](https://render.com) account (free tier works)
- [Vercel](https://vercel.com) account (free tier works)
- [Telegram](https://telegram.org) account
- [Android Studio](https://developer.android.com/studio) (latest stable version)

---

## 🖥️ Part 1: Deploying Backend to Render

### Step 1: Push to GitHub
Ensure your code is in a GitHub repository.

### Step 2: Create Render Web Service

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository
4. Select the repository containing your project

### Step 3: Configure Service Settings

| Setting | Value |
|---------|-------|
| **Name** | `customer-support-server` |
| **Root Directory** | `Web-App/server` |
| **Runtime** | `Node` |
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `npm start` |
| **Plan** | Free |

### Step 4: Set Environment Variables

In Render Dashboard → **Environment** section, add:

| Variable | Value | Description |
|----------|-------|-------------|
| `PORT` | `3001` | Server port |
| `NODE_ENV` | `production` | Production mode |
| `TELEGRAM_BOT_TOKEN` | `your_bot_token` | From @BotFather |
| `TELEGRAM_ADMIN_IDS` | `123456789` | Your Telegram user IDs (comma-separated) |

### Step 5: Deploy

Click **"Create Web Service"**. Render will:
- Install dependencies
- Build the TypeScript code
- Start the server

> **Note**: Free tier instances spin down after 15 mins of inactivity. First request after sleep takes ~30 seconds.

### Step 6: Copy Your Server URL

After deployment, your server URL will be:
```
https://your-service-name.onrender.com
```

---

## 🌐 Part 2: Deploying Frontend to Vercel

### Step 1: Create Vercel Project

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Click **"Add New..."** → **"Project"**
3. Import your GitHub repository

### Step 2: Configure Project Settings

| Setting | Value |
|---------|-------|
| **Framework Preset** | `Vite` |
| **Root Directory** | `Web-App/client` |
| **Build Command** | `npm run build` |
| **Output Directory** | `dist` |

### Step 3: Set Environment Variables

In Vercel → **Settings** → **Environment Variables**, add:

| Variable | Value |
|----------|-------|
| `VITE_BACKEND_URL` | `https://your-service-name.onrender.com` |
| `VITE_DEVICE_CONTROL_PASSWORD` | `YourSecurePassword123` |

> ⚠️ **Important**: Replace `your-service-name` with your actual Render service name.

> 🔐 **Security Note**: The `VITE_DEVICE_CONTROL_PASSWORD` protects the Device Control page. Change the default password to something secure.

### Step 4: Deploy

Click **"Deploy"**. Vercel will build and deploy your frontend.

Your frontend URL will be:
```
https://your-project.vercel.app
```

---

## 🔗 Part 3: Where to Change Server Links

### 1. Frontend (Web Client)

**File**: `Web-App/client/.env`

```env
# For local development
VITE_BACKEND_URL=http://localhost:3001

# For production (set in Vercel dashboard)
VITE_BACKEND_URL=https://your-service-name.onrender.com
```

**Used in**: `Web-App/client/src/contexts/SocketContext.tsx`
```typescript
const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
```

---

### 2. Android App

**File**: `Android-App/app/src/main/java/com/customersupport/socket/SocketManager.kt`

```kotlin
companion object {
    private const val TAG = "SocketManager"
    // Change this to your Render server URL
    private const val SERVER_URL = "https://your-service-name.onrender.com"
}
```

**Quick Reference:**
| Environment | URL Format |
|-------------|------------|
| Local (Emulator) | `http://10.0.2.2:3001` |
| Local (Physical) | `http://192.168.x.x:3001` |
| Production | `https://your-service-name.onrender.com` |

---

## 🤖 Part 4: Telegram Bot Setup

### Step 1: Create Bot with BotFather

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Follow prompts to name your bot
4. Copy the **bot token** (looks like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### Step 2: Get Your Admin User ID

1. Open Telegram and search for **@userinfobot**
2. Start the bot and it will show you your user ID
3. Copy your numeric user ID (e.g., `123456789`)

### Step 3: Set Environment Variables on Render

Go to Render Dashboard → Your Service → **Environment**:

| Variable | Value |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | `your_bot_token_from_botfather` |
| `TELEGRAM_ADMIN_IDS` | `your_user_id` |

**Multiple Admins:** Separate IDs with commas:
```
TELEGRAM_ADMIN_IDS=123456789,987654321,555555555
```

### Step 4: Restart Server

After updating environment variables, redeploy/restart your Render service.

### Step 5: Test the Bot

1. Find your bot on Telegram using its username
2. Send `/start`
3. You should see the welcome message with **Devices** and **Actions** buttons

### Available Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message with quick buttons |
| `/devices` | List all connected devices |
| `/actions` | Perform actions on devices |

---

## 📱 Part 5: Building Android APK

### Prerequisites

1. Install [Android Studio](https://developer.android.com/studio)
2. Install Android SDK (API 34)
3. Accept Android SDK licenses

### Step 1: Open Project in Android Studio

1. Open Android Studio
2. **File** → **Open**
3. Navigate to `Android-App` folder and open it
4. Wait for Gradle sync to complete

### Step 2: Update Server URL

Edit `app/src/main/java/com/customersupport/socket/SocketManager.kt`:

```kotlin
private const val SERVER_URL = "https://your-service-name.onrender.com"
```

### Step 3: Configure Signing (For Release APK)

Edit `app/build.gradle.kts`:

```kotlin
signingConfigs {
    create("release") {
        storeFile = file("my-release-key.keystore")
        storePassword = "YOUR_ACTUAL_STORE_PASSWORD"
        keyAlias = "my-key-alias"
        keyPassword = "YOUR_ACTUAL_KEY_PASSWORD"
    }
}
```

> ⚠️ **Security**: Never commit passwords to Git. Use environment variables or gradle.properties.

### Step 4: Generate Keystore (First time only)

If you don't have a keystore, create one:

```bash
cd Android-App

keytool -genkey -v -keystore my-release-key.keystore \
  -alias my-key-alias \
  -keyalg RSA -keysize 2048 -validity 10000
```

### Step 5: Build Options



#### Option C: Using Android Studio UI

1. **Build** → **Build Bundle(s) / APK(s)** → **Build APK(s)**
2. Wait for build to complete
3. Click **"locate"** in the notification

### Step 6: Install APK on Device

1. Transfer APK to your Android device
2. Enable **"Install from unknown sources"** in device settings
3. Open the APK file to install

---

## 📊 Environment Variables Summary

### Render (Backend Server)

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | Yes | Server port (3001) |
| `NODE_ENV` | Yes | `production` |
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_ADMIN_IDS` | Yes | Comma-separated admin IDs |

### Vercel (Frontend Client)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_BACKEND_URL` | Yes | Your Render server URL |
| `VITE_DEVICE_CONTROL_PASSWORD` | No | Password for Device Control page (default: `DevCtrl@2026#Secure`) |

### Android App (Hardcoded)

| Constant | File | Description |
|----------|------|-------------|
| `SERVER_URL` | `SocketManager.kt` | Your Render server URL |

---

## 🔄 Deployment Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                     Deployment Flow                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Deploy Backend to Render                                │
│     └─ Get URL: https://xxx.onrender.com                    │
│                           │                                 │
│                           ▼                                 │
│  2. Set VITE_BACKEND_URL in Vercel                         │
│     └─ Deploy Frontend                                      │
│                           │                                 │
│                           ▼                                 │
│  3. Update SERVER_URL in SocketManager.kt                   │
│     └─ Build Android APK                                    │
│                           │                                 │
│                           ▼                                 │
│  4. Configure Telegram Bot                                  │
│     └─ Set TELEGRAM_BOT_TOKEN & ADMIN_IDS on Render        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## ❓ Troubleshooting

### Render Issues

| Problem | Solution |
|---------|----------|
| Build fails | Check Node.js version, ensure dependencies install |
| 409 Conflict (Telegram) | Another bot instance is running; wait for old one to stop |
| WebSocket not connecting | Ensure CORS is enabled, check firewall |

### Vercel Issues

| Problem | Solution |
|---------|----------|
| API not connecting | Verify `VITE_BACKEND_URL` is set correctly |
| Build fails | Check TypeScript errors, run `npm run build` locally |

### Android Issues

| Problem | Solution |
|---------|----------|
| Connection fails | Check `SERVER_URL`, ensure `https://` prefix |
| Signing fails | Verify keystore path and passwords |
| Permissions denied | Grant all required permissions in app settings |

### Telegram Bot Issues

| Problem | Solution |
|---------|----------|
| Bot not responding | Check token is correct, verify admin IDs |
| Unauthorized access | Add your user ID to `TELEGRAM_ADMIN_IDS` |

---

## 🎉 You're Done!

Your Customer Support platform should now be fully deployed:

- ✅ Backend running on Render
- ✅ Frontend accessible on Vercel  
- ✅ Telegram bot active and responding
- ✅ Android APK ready for installation

**Need Help?** Check the troubleshooting section or review server logs on Render dashboard.
