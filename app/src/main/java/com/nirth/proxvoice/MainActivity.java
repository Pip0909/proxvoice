package com.nirth.proxvoice;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.WindowManager;
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
 * Thin shell around the Proximity Voice web app.
 * First launch asks for the server address (e.g. https://voice.example.com).
 */
public class MainActivity extends Activity {
    private static final int REQ_AUDIO = 1;
    private static final String PREFS = "proxvoice";
    private static final String KEY_URL = "server_url";

    private WebView web;
    private PermissionRequest pendingWebRequest;
    private boolean dialogOpen = false;

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

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    askServer("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบที่อยู่แล้วลองใหม่");
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        handleWebPermission(request);
                    }
                });
            }
        });

        // ask for the mic up front so the web page's own prompt is instant
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
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

    /** Dialog to enter or change the server address. */
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

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
