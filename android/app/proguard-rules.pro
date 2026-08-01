# JavaScript bridge methods must remain visible to Android WebView.
-keepclassmembers class com.signalpilot.app.MainActivity$SignalPilotBridge {
    @android.webkit.JavascriptInterface <methods>;
}
