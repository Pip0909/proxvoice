package com.nirth.proxvoice;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Thin shell around the Proximity Voice web app, with optional
 * Discord-style mobile voice overlay when the user switches to Minecraft.
 */
public class MainActivity extends Activity {
    private static final int REQ_AUDIO = 1;
    private static final int REQ_OVERLAY = 2;
    private static final int REQ_NOTIF = 3;
    private boolean notifAsked = false;
    private static final String PREFS = "proxvoice";
    private static final String KEY_URL = "server_url";

    private WebView web;
    private View loadingView;
    private TextView loadingText;
    private PermissionRequest pendingWebRequest;
    private boolean dialogOpen = false;
    private boolean overlayWanted = false;

    private final BroadcastReceiver overlayActions = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || intent.getAction() == null || web == null) return;
            String action = intent.getAction();
            if (OverlayService.ACTION_TOGGLE_MIC.equals(action)) {
                web.evaluateJavascript(
                        "(function(){var b=document.getElementById('micBtn')||document.getElementById('floatMic');if(b)b.click();})();",
                        null);
            } else if (OverlayService.ACTION_TOGGLE_DEAF.equals(action)) {
                web.evaluateJavascript(
                        "(function(){var b=document.getElementById('deafBtn')||document.getElementById('floatDeaf');if(b)b.click();})();",
                        null);
            } else if (OverlayService.ACTION_RANGE_DOWN.equals(action)) {
                web.evaluateJavascript(
                        "(function(){var b=document.getElementById('rangeDown')||document.getElementById('floatRangeDown');if(b)b.click();})();",
                        null);
            } else if (OverlayService.ACTION_RANGE_UP.equals(action)) {
                web.evaluateJavascript(
                        "(function(){var b=document.getElementById('rangeUp')||document.getElementById('floatRangeUp');if(b)b.click();})();",
                        null);
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0F1720);

        web = new WebView(this);
        web.setBackgroundColor(0xFF0F1720);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        loadingView = buildLoadingView();
        root.addView(loadingView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);

        web.addJavascriptInterface(new ProxVoiceBridge(), "ProxVoiceNative");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                showLoading("กำลังเชื่อมต่อเซิร์ฟเวอร์…\n(ครั้งแรกอาจช้า ถ้า Render เพิ่งตื่น)");
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    hideLoading();
                    askServer("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบที่อยู่แล้วลองใหม่");
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectBridgeHelper();
                // Small delay so the HTML paint isn't a white flash before UI appears
                view.postDelayed(() -> hideLoading(), 250);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> handleWebPermission(request));
            }
        });

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
        }

        IntentFilter filter = new IntentFilter();
        filter.addAction(OverlayService.ACTION_TOGGLE_MIC);
        filter.addAction(OverlayService.ACTION_TOGGLE_DEAF);
        filter.addAction(OverlayService.ACTION_RANGE_DOWN);
        filter.addAction(OverlayService.ACTION_RANGE_UP);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(overlayActions, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(overlayActions, filter);
        }

        String url = prefs().getString(KEY_URL, "");
        if (url.isEmpty()) {
            hideLoading();
            askServer(null);
        } else {
            openServer(url);
        }
    }

    private View buildLoadingView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(0xFF0F1720);
        box.setPadding(dp(24), dp(24), dp(24), dp(24));

        ProgressBar spin = new ProgressBar(this);
        box.addView(spin, new LinearLayout.LayoutParams(dp(48), dp(48)));

        loadingText = new TextView(this);
        loadingText.setText("กำลังเชื่อมต่อเซิร์ฟเวอร์…");
        loadingText.setTextColor(0xFFE8EEF5);
        loadingText.setTextSize(16);
        loadingText.setGravity(Gravity.CENTER);
        loadingText.setPadding(0, dp(18), 0, 0);
        box.addView(loadingText, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView sub = new TextView(this);
        sub.setText("Proximity Voice");
        sub.setTextColor(0xFF8DA0B4);
        sub.setTextSize(13);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, dp(8), 0, 0);
        box.addView(sub);

        return box;
    }

    private void showLoading(String message) {
        if (loadingText != null && message != null) loadingText.setText(message);
        if (loadingView != null) loadingView.setVisibility(View.VISIBLE);
    }

    private void hideLoading() {
        if (loadingView != null) loadingView.setVisibility(View.GONE);
    }

    private void openServer(String url) {
        showLoading("กำลังเชื่อมต่อเซิร์ฟเวอร์…\n(ครั้งแรกอาจช้า ถ้า Render เพิ่งตื่น)");
        web.loadUrl(url);
        checkForUpdate(url);
    }

    /** Ask Render (/api/app-version) whether a newer APK is available. */
    private void checkForUpdate(String serverUrl) {
        if (serverUrl == null || serverUrl.isEmpty()) return;
        final String base = serverUrl.endsWith("/") ? serverUrl.substring(0, serverUrl.length() - 1) : serverUrl;
        new Thread(() -> {
            try {
                URL u = new URL(base + "/api/app-version");
                HttpURLConnection conn = (HttpURLConnection) u.openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setRequestProperty("Accept", "application/json");
                conn.setRequestProperty("User-Agent", "ProximityVoice-Android");
                int code = conn.getResponseCode();
                if (code != 200) return;
                StringBuilder sb = new StringBuilder();
                try (BufferedReader br = new BufferedReader(
                        new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = br.readLine()) != null) sb.append(line);
                }
                JSONObject json = new JSONObject(sb.toString());
                int remoteCode = json.optInt("versionCode", 0);
                String remoteName = json.optString("versionName", "");
                String apkUrl = json.optString("apkUrl", "");
                String notes = json.optString("notes", "");
                boolean force = json.optBoolean("force", false);
                int localCode = currentVersionCode();
                if (remoteCode <= localCode || apkUrl.isEmpty()) return;
                runOnUiThread(() -> promptUpdate(remoteName, notes, apkUrl, force));
            } catch (Exception ignored) {
                // offline / cold start — skip quietly
            }
        }).start();
    }

    private int currentVersionCode() {
        try {
            if (Build.VERSION.SDK_INT >= 28) {
                return (int) getPackageManager()
                        .getPackageInfo(getPackageName(), 0).getLongVersionCode();
            }
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private void promptUpdate(String versionName, String notes, String apkUrl, boolean force) {
        if (isFinishing()) return;
        String msg = "มีเวอร์ชันใหม่" + (versionName.isEmpty() ? "" : " v" + versionName);
        if (notes != null && !notes.isEmpty()) msg += "\n\n" + notes;
        msg += "\n\nต้องการอัปเดตตอนนี้ไหม?";

        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("อัปเดตแอป")
                .setMessage(msg)
                .setCancelable(!force)
                .setPositiveButton("อัปเดต", (d, w) -> {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(apkUrl)));
                    } catch (Exception e) {
                        Toast.makeText(this, "เปิดลิงก์อัปเดตไม่ได้", Toast.LENGTH_LONG).show();
                    }
                });
        if (!force) {
            b.setNegativeButton("ภายหลัง", null);
        }
        b.show();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void handleWebPermission(PermissionRequest request) {
        boolean wantsAudio = false;
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsAudio = true;
        }
        if (!wantsAudio) {
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            pendingWebRequest = request;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code != REQ_AUDIO) return;
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (pendingWebRequest != null) {
            if (ok) pendingWebRequest.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else pendingWebRequest.deny();
            pendingWebRequest = null;
        }
        if (!ok) {
            Toast.makeText(this, "ต้องอนุญาตไมโครโฟนถึงจะคุยได้", Toast.LENGTH_LONG).show();
        }
    }

    private void askServer(String message) {
        if (dialogOpen) return;
        dialogOpen = true;

        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setHint("https://voice.example.com");
        input.setText(prefs().getString(KEY_URL, ""));

        new AlertDialog.Builder(this)
                .setTitle("ที่อยู่เซิร์ฟเวอร์เสียง")
                .setMessage(message != null ? message : "ใส่ที่อยู่ที่ขึ้นต้นด้วย https://")
                .setView(input)
                .setCancelable(false)
                .setPositiveButton("เชื่อมต่อ", (d, w) -> {
                    dialogOpen = false;
                    String url = input.getText().toString().trim();
                    if (url.isEmpty()) {
                        askServer("กรอกที่อยู่เซิร์ฟเวอร์ก่อน");
                        return;
                    }
                    if (!url.startsWith("http://") && !url.startsWith("https://")) {
                        url = "https://" + url;
                    }
                    prefs().edit().putString(KEY_URL, url).apply();
                    openServer(url);
                })
                .setNegativeButton("ออก", (d, w) -> {
                    dialogOpen = false;
                    finish();
                })
                .show();
    }

    /** Inject a small helper so the web app can detect the native shell. */
    private void injectBridgeHelper() {
        if (web == null) return;
        web.evaluateJavascript(
                "(function(){window.__proxvoiceNative=true;"
                        + "window.ProxVoiceOverlay={show:function(n,s,m,d,r){if(window.ProxVoiceNative)ProxVoiceNative.showOverlay(n||'',s||'',!!m,!!d,r||'');},"
                        + "hide:function(){if(window.ProxVoiceNative)ProxVoiceNative.hideOverlay();},"
                        + "update:function(n,s,m,d,r){if(window.ProxVoiceNative)ProxVoiceNative.updateOverlay(n||'',s||'',!!m,!!d,r||'');},"
                        + "available:function(){return!!window.ProxVoiceNative;}};"
                        + "})();",
                null);
    }

    private boolean canDrawOverlays() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        return Settings.canDrawOverlays(this);
    }

    private void requestOverlayPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        if (canDrawOverlays()) return;
        Toast.makeText(this, "อนุญาต 'แสดงทับแอปอื่น' เพื่อใช้แถบลอย (ไม่อนุญาตก็ใช้ปุ่มในแถบแจ้งเตือนได้)", Toast.LENGTH_LONG).show();
        try {
            Intent intent = new Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getPackageName())
            );
            startActivityForResult(intent, REQ_OVERLAY);
        } catch (Exception e) {
            // some phones (Go / custom ROMs) have no such screen: open the app's own settings page instead
            try {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + getPackageName())));
            } catch (Exception ignored) {
            }
        }
    }

    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33 || notifAsked) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notifAsked = true;
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }
    }

    private Intent overlayIntent(String action, String name, String status, boolean muted, boolean deafened, String range) {
        Intent i = new Intent(this, OverlayService.class);
        i.setAction(action);
        i.putExtra(OverlayService.EXTRA_NAME, name);
        i.putExtra(OverlayService.EXTRA_STATUS, status);
        i.putExtra(OverlayService.EXTRA_MUTED, muted);
        i.putExtra(OverlayService.EXTRA_DEAFENED, deafened);
        i.putExtra(OverlayService.EXTRA_RANGE, range != null ? range : "\u2013");
        return i;
    }

    private void startOverlay(String name, String status, boolean muted, boolean deafened, String range) {
        overlayWanted = true;
        // Foreground service of type "microphone" needs the mic permission first (Android 14+ throws otherwise)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
            return;
        }
        // No early return when the floating-window permission is missing: the notification buttons still work.
        if (!canDrawOverlays()) requestOverlayPermission();
        ensureNotificationPermission();
        OverlayService.push(this, overlayIntent(OverlayService.ACTION_SHOW, name, status, muted, deafened, range), true);
    }

    private void updateOverlay(String name, String status, boolean muted, boolean deafened, String range) {
        if (!overlayWanted) return;
        OverlayService.push(this, overlayIntent(OverlayService.ACTION_UPDATE, name, status, muted, deafened, range), false);
    }

    private void stopOverlay() {
        overlayWanted = false;
        try {
            Intent i = new Intent(this, OverlayService.class);
            i.setAction(OverlayService.ACTION_HIDE);
            OverlayService.push(this, i, false);
            stopService(new Intent(this, OverlayService.class));
        } catch (Exception ignored) {
        }
    }

    public class ProxVoiceBridge {
        @JavascriptInterface
        public void showOverlay(String name, String status, boolean muted, boolean deafened, String range) {
            runOnUiThread(() -> MainActivity.this.startOverlay(name, status, muted, deafened, range));
        }

        @JavascriptInterface
        public void updateOverlay(String name, String status, boolean muted, boolean deafened, String range) {
            runOnUiThread(() -> MainActivity.this.updateOverlay(name, status, muted, deafened, range));
        }

        @JavascriptInterface
        public void hideOverlay() {
            runOnUiThread(MainActivity.this::stopOverlay);
        }

        @JavascriptInterface
        public boolean hasOverlayPermission() {
            return canDrawOverlays();
        }

        @JavascriptInterface
        public void requestOverlayPermission() {
            runOnUiThread(MainActivity.this::requestOverlayPermission);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_OVERLAY && overlayWanted && canDrawOverlays()) {
            OverlayService.push(this, overlayIntent(OverlayService.ACTION_SHOW, "Proximity Voice", "Connected", false, false, "\u2013"), true);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Keep voice session + floating overlay while user is in Minecraft
        if (overlayWanted && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            OverlayService.push(this, overlayIntent(OverlayService.ACTION_SHOW, "Proximity Voice", "In game", false, false, "\u2013"), true);
        }
        if (web != null) {
            web.evaluateJavascript(
                    "(function(){try{if(window.ProxVoiceNative&&document.getElementById('status')){"
                            + "var n=(document.getElementById('meName')||{}).textContent||'';"
                            + "var s=(document.getElementById('status')||{}).textContent||'';"
                            + "var m=!!(document.getElementById('micBtn')&&document.getElementById('micBtn').classList.contains('is-off'));"
                            + "var d=!!(document.getElementById('deafBtn')&&document.getElementById('deafBtn').classList.contains('is-off'));"
                            + "var r=(document.getElementById('rangeNum')||document.getElementById('floatRangeNum')||{}).textContent||'–';"
                            + "ProxVoiceNative.updateOverlay(n,s,m,d,r);}}catch(e){}})();",
                    null);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.evaluateJavascript(
                    "(function(){try{if(window.audioCtx&&window.audioCtx.state==='suspended')window.audioCtx.resume();}catch(e){}})();",
                    null);
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        try {
            unregisterReceiver(overlayActions);
        } catch (Exception ignored) {
        }
        stopOverlay();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
