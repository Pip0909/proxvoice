package com.nirth.proxvoice;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.IBinder;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Discord-style mobile voice overlay that floats above other apps
 * (e.g. Minecraft) while the WebView keeps the voice session alive.
 */
public class OverlayService extends Service {
    public static final String ACTION_SHOW = "com.nirth.proxvoice.OVERLAY_SHOW";
    public static final String ACTION_HIDE = "com.nirth.proxvoice.OVERLAY_HIDE";
    public static final String ACTION_UPDATE = "com.nirth.proxvoice.OVERLAY_UPDATE";
    public static final String ACTION_TOGGLE_MIC = "com.nirth.proxvoice.TOGGLE_MIC";
    public static final String ACTION_TOGGLE_DEAF = "com.nirth.proxvoice.TOGGLE_DEAF";

    public static final String EXTRA_NAME = "name";
    public static final String EXTRA_STATUS = "status";
    public static final String EXTRA_MUTED = "muted";
    public static final String EXTRA_DEAFENED = "deafened";

    private static final String CHANNEL_ID = "proxvoice_overlay";
    private static final int NOTIF_ID = 42;
    private static final int TAG_MIC = 0x70F10001;
    private static final int TAG_DEAF = 0x70F10002;

    private WindowManager windowManager;
    private View overlayView;
    private WindowManager.LayoutParams params;
    private TextView nameView;
    private TextView statusView;

    private String displayName = "Proximity Voice";
    private String statusText = "Connected";
    private boolean muted = false;
    private boolean deafened = false;

    private int startX, startY;
    private float touchX, touchY;

    @Override
    public void onCreate() {
        super.onCreate();
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        createChannel();
        startForeground(NOTIF_ID, buildNotification());
        addOverlay();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_STICKY;
        String action = intent.getAction();
        if (ACTION_HIDE.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_UPDATE.equals(action) || ACTION_SHOW.equals(action)) {
            if (intent.hasExtra(EXTRA_NAME)) {
                String n = intent.getStringExtra(EXTRA_NAME);
                if (n != null && !n.isEmpty()) displayName = n;
            }
            if (intent.hasExtra(EXTRA_STATUS)) {
                String s = intent.getStringExtra(EXTRA_STATUS);
                if (s != null) statusText = s;
            }
            muted = intent.getBooleanExtra(EXTRA_MUTED, muted);
            deafened = intent.getBooleanExtra(EXTRA_DEAFENED, deafened);
            applyUi();
            updateNotification();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        removeOverlay();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void addOverlay() {
        if (overlayView != null) return;

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

        params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = 24;
        params.y = 180;

        overlayView = buildOverlayView();
        windowManager.addView(overlayView, params);
        applyUi();
    }

    private View buildOverlayView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.HORIZONTAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        root.setPadding(dp(12), dp(10), dp(10), dp(10));
        root.setBackgroundColor(0xF21E1F22);
        root.setElevation(dp(10));

        LinearLayout meta = new LinearLayout(this);
        meta.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams metaLp = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        meta.setLayoutParams(metaLp);
        meta.setPadding(0, 0, dp(8), 0);

        nameView = new TextView(this);
        nameView.setTextColor(0xFFFFFFFF);
        nameView.setTextSize(13);
        nameView.setMaxLines(1);
        nameView.setText(displayName);

        statusView = new TextView(this);
        statusView.setTextColor(0xFF8DA0B4);
        statusView.setTextSize(11);
        statusView.setMaxLines(1);
        statusView.setText(statusText);

        meta.addView(nameView);
        meta.addView(statusView);

        TextView mic = textBtn("🎙");
        TextView deaf = textBtn("🎧");
        TextView open = textBtn("↗");
        TextView close = textBtn("✕");

        mic.setOnClickListener(v -> sendBroadcastAction(ACTION_TOGGLE_MIC));
        deaf.setOnClickListener(v -> sendBroadcastAction(ACTION_TOGGLE_DEAF));
        open.setOnClickListener(v -> {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            startActivity(i);
        });
        close.setOnClickListener(v -> stopSelf());

        root.setTag(TAG_MIC, mic);
        root.setTag(TAG_DEAF, deaf);

        root.addView(meta);
        root.addView(mic);
        root.addView(deaf);
        root.addView(open);
        root.addView(close);

        root.setOnTouchListener(this::onDrag);
        return root;
    }

    private TextView textBtn(String emoji) {
        TextView t = new TextView(this);
        t.setText(emoji);
        t.setTextSize(16);
        t.setGravity(Gravity.CENTER);
        t.setTextColor(0xFFFFFFFF);
        t.setBackgroundColor(0xFF2B2D31);
        t.setPadding(dp(10), dp(8), dp(10), dp(8));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(40), dp(40));
        lp.setMargins(dp(3), 0, dp(3), 0);
        t.setLayoutParams(lp);
        t.setClickable(true);
        t.setFocusable(true);
        return t;
    }

    private boolean onDrag(View v, MotionEvent event) {
        switch (event.getAction()) {
            case MotionEvent.ACTION_DOWN:
                startX = params.x;
                startY = params.y;
                touchX = event.getRawX();
                touchY = event.getRawY();
                return true;
            case MotionEvent.ACTION_MOVE:
                params.x = startX + (int) (event.getRawX() - touchX);
                params.y = startY + (int) (event.getRawY() - touchY);
                if (overlayView != null) {
                    windowManager.updateViewLayout(overlayView, params);
                }
                return true;
            default:
                return false;
        }
    }

    private void applyUi() {
        if (nameView != null) {
            nameView.setText(displayName != null ? displayName : "Proximity Voice");
        }
        if (statusView != null) {
            statusView.setText(statusText != null ? statusText : "");
            boolean waiting = statusText != null && statusText.toLowerCase().contains("wait");
            statusView.setTextColor(waiting ? 0xFFF0B429 : 0xFF3DDC97);
        }
        if (overlayView != null) {
            Object micObj = overlayView.getTag(TAG_MIC);
            Object deafObj = overlayView.getTag(TAG_DEAF);
            if (micObj instanceof TextView) {
                TextView mic = (TextView) micObj;
                mic.setText(muted || deafened ? "🔇" : "🎙");
                mic.setBackgroundColor(muted || deafened ? 0xFFFF5D6C : 0xFF2B2D31);
            }
            if (deafObj instanceof TextView) {
                TextView deaf = (TextView) deafObj;
                deaf.setText(deafened ? "🙉" : "🎧");
                deaf.setBackgroundColor(deafened ? 0xFFFF5D6C : 0xFF2B2D31);
            }
        }
    }

    private void removeOverlay() {
        if (overlayView != null && windowManager != null) {
            try {
                windowManager.removeView(overlayView);
            } catch (Exception ignored) {
            }
            overlayView = null;
        }
    }

    private void sendBroadcastAction(String action) {
        Intent i = new Intent(action);
        i.setPackage(getPackageName());
        sendBroadcast(i);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID,
                "Proximity Voice",
                NotificationManager.IMPORTANCE_LOW
        );
        ch.setDescription("Voice overlay while in game");
        ch.setShowBadge(false);
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(ch);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
        }
        return b.setContentTitle("Proximity Voice")
                .setContentText(displayName + " · " + statusText)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private void updateNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ID, buildNotification());
    }

    private int dp(int v) {
        float d = getResources().getDisplayMetrics().density;
        return Math.round(v * d);
    }
}
