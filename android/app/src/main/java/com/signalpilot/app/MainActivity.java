package com.signalpilot.localhost3001;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.AtomicFile;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public class MainActivity extends Activity {
    private static final String START_URL = "file:///android_asset/index.html";
    private static final String CHANNEL_ID = "signalpilot_alerts";
    private WebView webView;
    private SignalPilotBridge bridge;

    @Override
    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.rgb(90, 75, 224));
        getWindow().setNavigationBarColor(Color.rgb(13, 17, 23));
        createNotificationChannel();
        requestNotificationPermission();

        webView = new WebView(this);
        setContentView(webView);
        webView.setBackgroundColor(Color.rgb(13, 17, 23));
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setDatabaseEnabled(true);
        webView.getSettings().setAllowContentAccess(false);
        webView.getSettings().setAllowFileAccess(true);
        webView.getSettings().setAllowFileAccessFromFileURLs(false);
        webView.getSettings().setAllowUniversalAccessFromFileURLs(false);
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        webView.getSettings().setUserAgentString(webView.getSettings().getUserAgentString() + " SignalPilotAndroid/1.0");

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        bridge = new SignalPilotBridge(this, webView);
        webView.addJavascriptInterface(bridge, "SignalPilotAndroid");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("file".equalsIgnoreCase(uri.getScheme()) && uri.getPath() != null && uri.getPath().startsWith("/android_asset/")) return false;
                if ("https".equalsIgnoreCase(uri.getScheme())) {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                }
                return true;
            }
        });
        webView.loadUrl(START_URL);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Alerte SignalPilot",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Semnale UP/DOWN detectate de SignalPilot");
        channel.enableVibration(true);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (bridge != null) bridge.setForeground(true);
        if (webView != null) webView.evaluateJavascript("window.SignalPilotMobile && window.SignalPilotMobile.resume()", null);
    }

    @Override
    protected void onPause() {
        if (bridge != null) bridge.setForeground(false);
        if (webView != null) webView.evaluateJavascript("window.SignalPilotMobile && window.SignalPilotMobile.pause()", null);
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.shutdown();
        if (webView != null) {
            webView.removeJavascriptInterface("SignalPilotAndroid");
            webView.destroy();
        }
        super.onDestroy();
    }

    public static final class SignalPilotBridge {
        private static final Set<String> ALLOWED_HOSTS = new HashSet<>(Arrays.asList(
            "api.mexc.com",
            "data-api.binance.vision",
            "generativelanguage.googleapis.com"
        ));
        private final Context context;
        private final WebView webView;
        private final ExecutorService network = Executors.newFixedThreadPool(4);
        private final Set<HttpURLConnection> activeConnections = ConcurrentHashMap.newKeySet();
        private final AtomicInteger notificationIds = new AtomicInteger(100);
        private final File storageDir;
        private final Object storageLock = new Object();
        private volatile boolean foreground = true;
        private volatile boolean destroyed = false;

        SignalPilotBridge(Context context, WebView webView) {
            this.context = context.getApplicationContext();
            this.webView = webView;
            this.storageDir = new File(context.getFilesDir(), "signalpilot-store");
            if (!storageDir.exists()) storageDir.mkdirs();
        }

        @JavascriptInterface
        public void http(String requestId, String method, String rawUrl, String body, String headersJson) {
            if (destroyed) return;
            if (!foreground) {
                callback(requestId, 0, "", "Aplicația este în fundal");
                return;
            }
            network.execute(() -> executeHttp(requestId, method, rawUrl, body, headersJson));
        }

        void setForeground(boolean value) {
            foreground = value;
            if (!value) {
                for (HttpURLConnection connection : activeConnections) connection.disconnect();
            }
        }

        private void executeHttp(String requestId, String method, String rawUrl, String body, String headersJson) {
            HttpURLConnection connection = null;
            try {
                if (destroyed) return;
                if (!foreground) {
                    callback(requestId, 0, "", "Aplicația este în fundal");
                    return;
                }
                URL url = new URL(rawUrl);
                if (!"https".equalsIgnoreCase(url.getProtocol()) || !ALLOWED_HOSTS.contains(url.getHost())) {
                    throw new SecurityException("Host HTTPS nepermis: " + url.getHost());
                }
                connection = (HttpURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(false);
                activeConnections.add(connection);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(45000);
                connection.setRequestMethod(method == null ? "GET" : method.toUpperCase());
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("User-Agent", "SignalPilotAndroid/1.0");

                JSONObject headers = headersJson == null || headersJson.isEmpty()
                    ? new JSONObject()
                    : new JSONObject(headersJson);
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    if (!key.equalsIgnoreCase("Host") && !key.equalsIgnoreCase("Content-Length")) {
                        connection.setRequestProperty(key, headers.optString(key));
                    }
                }

                if (body != null && !body.isEmpty() && !"GET".equalsIgnoreCase(method)) {
                    connection.setDoOutput(true);
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    connection.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream output = connection.getOutputStream()) {
                        output.write(bytes);
                    }
                }

                int status = connection.getResponseCode();
                InputStream stream = status >= 200 && status < 400
                    ? connection.getInputStream()
                    : connection.getErrorStream();
                String response = readAll(stream);
                callback(requestId, status, response, null);
            } catch (Exception error) {
                callback(requestId, 0, "", error.getClass().getSimpleName() + ": " + error.getMessage());
            } finally {
                if (connection != null) {
                    activeConnections.remove(connection);
                    connection.disconnect();
                }
            }
        }

        private String readAll(InputStream stream) throws Exception {
            if (stream == null) return "";
            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) output.append(line).append('\n');
            }
            return output.toString();
        }

        private void callback(String requestId, int status, String body, String error) {
            if (destroyed) return;
            String script = "window.__signalPilotNativeResponse(" +
                JSONObject.quote(requestId) + "," + status + "," +
                JSONObject.quote(body == null ? "" : body) + "," +
                (error == null ? "null" : JSONObject.quote(error)) + ")";
            String pausedScript = "window.__signalPilotNativeResponse(" +
                JSONObject.quote(requestId) + ",0,\"\"," +
                JSONObject.quote("Aplicația este în fundal") + ")";
            webView.post(() -> {
                if (!destroyed && webView != null) {
                    webView.evaluateJavascript(foreground ? script : pausedScript, null);
                }
            });
        }

        @JavascriptInterface
        public String readStore(String key) {
            synchronized (storageLock) {
                File file = storeFile(key);
                if (!file.exists()) return "";
                AtomicFile atomic = new AtomicFile(file);
                try (FileInputStream input = atomic.openRead();
                     ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                    return output.toString(StandardCharsets.UTF_8.name());
                } catch (Exception error) {
                    Log.e("SignalPilot", "Nu pot citi stocarea " + key, error);
                    throw new IllegalStateException("Nu pot citi stocarea locală");
                }
            }
        }

        @JavascriptInterface
        public boolean writeStore(String key, String value) {
            synchronized (storageLock) {
                AtomicFile atomic = new AtomicFile(storeFile(key));
                FileOutputStream output = null;
                try {
                    output = atomic.startWrite();
                    output.write((value == null ? "" : value).getBytes(StandardCharsets.UTF_8));
                    atomic.finishWrite(output);
                    return true;
                } catch (Exception error) {
                    if (output != null) atomic.failWrite(output);
                    Log.e("SignalPilot", "Nu pot salva stocarea " + key, error);
                    return false;
                }
            }
        }

        private File storeFile(String key) {
            String safe = key == null ? "default" : key.replaceAll("[^A-Za-z0-9._-]", "_");
            return new File(storageDir, safe + ".json");
        }

        @JavascriptInterface
        public void notify(String title, String body) {
            Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
            if (launch == null) launch = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.getPackageName()));
            PendingIntent pendingIntent = PendingIntent.getActivity(
                context,
                0,
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            android.app.Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new android.app.Notification.Builder(context, CHANNEL_ID)
                : new android.app.Notification.Builder(context);
            builder.setSmallIcon(android.R.drawable.stat_notify_more)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new android.app.Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .setPriority(android.app.Notification.PRIORITY_HIGH);
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            manager.notify(notificationIds.incrementAndGet(), builder.build());
        }

        void shutdown() {
            destroyed = true;
            for (HttpURLConnection connection : activeConnections) connection.disconnect();
            activeConnections.clear();
            network.shutdownNow();
        }
    }
}
