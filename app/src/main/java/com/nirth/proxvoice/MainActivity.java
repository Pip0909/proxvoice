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
import android.view.KeyEvent;
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
import android.widget.Toast;

/**
 * Thin shell around the Proximity Voice web app, with optional
 * Discord-style mobile voice overlay when the user switches to Minecraft.
 */
public class MainActivity extends Activity {
    private static final int REQ_AUDIO = 1;
    private static final int REQ_OVERLAY = 2;
    private static final String PREFS = "proxvoice";
    private static final String KEY_URL = "server_url";

    private WebView web;
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
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(0xFF0F1720);
        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);

        web.addJavascriptInterface(new ProxVoiceBridge(), "ProxVoiceNative");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    askServer("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบที่อยู่แล้วลองใหม่");
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectBridgeHelper();
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(overlayActions, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(overlayActions, filter);
        }

        String url = prefs().getString(KEY_URL, "");
        if (url.isEmpty()) {
            askServer(null);
        } else {
            web.loadUrl(url);
        }
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
                    web.loadUrl(url);
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
                        + "window.ProxVoiceOverlay={show:function(n,s,m,d){if(window.ProxVoiceNative)ProxVoiceNative.showOverlay(n||'',s||'',!!m,!!d);},"
                        + "hide:function(){if(window.ProxVoiceNative)ProxVoiceNative.hideOverlay();},"
                        + "update:function(n,s,m,d){if(window.ProxVoiceNative)ProxVoiceNative.updateOverlay(n||'',s||'',!!m,!!d);},"
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
        Toast.makeText(this, "อนุญาต 'แสดงทับแอปอื่น' เพื่อใช้ Voice Overlay", Toast.LENGTH_LONG).show();
        Intent intent = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getPackageName())
        );
        startActivityForResult(intent, REQ_OVERLAY);
    }

    private void startOverlay(String name, String status, boolean muted, boolean deafened) {
        overlayWanted = true;
        if (!canDrawOverlays()) {
            requestOverlayPermission();
            return;
        }
        Intent i = new Intent(this, OverlayService.class);
        i.setAction(OverlayService.ACTION_SHOW);
        i.putExtra(OverlayService.EXTRA_NAME, name);
        i.putExtra(OverlayService.EXTRA_STATUS, status);
        i.putExtra(OverlayService.EXTRA_MUTED, muted);
        i.putExtra(OverlayService.EXTRA_DEAFENED, deafened);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(i);
        } else {
            startService(i);
        }
    }

    private void updateOverlay(String name, String status, boolean muted, boolean deafened) {
        if (!overlayWanted) return;
        Intent i = new Intent(this, OverlayService.class);
        i.setAction(OverlayService.ACTION_UPDATE);
        i.putExtra(OverlayService.EXTRA_NAME, name);
        i.putExtra(OverlayService.EXTRA_STATUS, status);
        i.putExtra(OverlayService.EXTRA_MUTED, muted);
        i.putExtra(OverlayService.EXTRA_DEAFENED, deafened);
        startService(i);
    }

    private void stopOverlay() {
        overlayWanted = false;
        Intent i = new Intent(this, OverlayService.class);
        i.setAction(OverlayService.ACTION_HIDE);
        startService(i);
        stopService(new Intent(this, OverlayService.class));
    }

    public class ProxVoiceBridge {
        @JavascriptInterface
        public void showOverlay(String name, String status, boolean muted, boolean deafened) {
            runOnUiThread(() -> MainActivity.this.startOverlay(name, status, muted, deafened));
        }

        @JavascriptInterface
        public void updateOverlay(String name, String status, boolean muted, boolean deafened) {
            runOnUiThread(() -> MainActivity.this.updateOverlay(name, status, muted, deafened));
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
            startOverlay("Proximity Voice", "Connected", false, false);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Keep voice session + floating overlay while user is in Minecraft
        if (overlayWanted && canDrawOverlays()) {
            Intent i = new Intent(this, OverlayService.class);
            i.setAction(OverlayService.ACTION_SHOW);
            i.putExtra(OverlayService.EXTRA_NAME, "Proximity Voice");
            i.putExtra(OverlayService.EXTRA_STATUS, "In game");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(i);
            } else {
                startService(i);
            }
        }
        if (web != null) {
            web.evaluateJavascript(
                    "(function(){try{if(window.ProxVoiceNative&&document.getElementById('status')){"
                            + "var n=(document.getElementById('meName')||{}).textContent||'';"
                            + "var s=(document.getElementById('status')||{}).textContent||'';"
                            + "var m=!!(document.getElementById('micBtn')&&document.getElementById('micBtn').classList.contains('is-off'));"
                            + "var d=!!(document.getElementById('deafBtn')&&document.getElementById('deafBtn').classList.contains('is-off'));"
                            + "ProxVoiceNative.updateOverlay(n,s,m,d);}}catch(e){}})();",
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
