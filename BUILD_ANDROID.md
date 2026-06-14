# Build Android APK with Bluetooth Printer Support

## Prerequisites
1. Install **Android Studio** (includes JDK and Android SDK)
2. Open Android Studio → SDK Manager → install SDK 36
3. Clone this repo to your PC

## Steps
1. Open a terminal in the project folder
2. Install npm deps:
   ```
   npm install
   ```
3. Sync Capacitor with Android:
   ```
   npx cap sync android
   ```
4. Open the Android project in Android Studio:
   ```
   npx cap open android
   ```
5. In Android Studio:
   - Wait for Gradle sync to finish
   - Connect your tablet via USB (enable Developer Options + USB Debugging)
   - Click **Run** (green triangle) → select your tablet
   - Or: **Build** → **Build Bundle(s) / APK(s)** → **Build APK(s)**
6. The APK will be at `android/app/build/outputs/apk/debug/app-debug.apk`

## Note
- The app loads from Railway (cloud). No Flask server needed locally.
- Bluetooth printer must be paired in Android Settings before using the app.
- Tap **Print Kitchen** / **Print Customer** → prints directly via Bluetooth.
