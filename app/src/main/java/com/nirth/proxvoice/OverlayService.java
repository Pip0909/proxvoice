package com.nirth.proxvoice;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.IBinder;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.ViewConfiguration;
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
    public static final String ACTION_RANGE_DOWN = "com.nirth.proxvoice.RANGE_DOWN";
    public static final String ACTION_RANGE_UP = "com.nirth.proxvoice.RANGE_UP";

    public static final String EXTRA_NAME = "name";
    public static final String EXTRA_STATUS = "status";
    public static final String EXTRA_MUTED = "muted";
    public static final String EXTRA_DEAFENED = "deafened";
    public static final String EXTRA_RANGE = "range";

    private static final String CHANNEL_ID = "proxvoice_overlay";
    private static final int NOTIF_ID = 42;

    private static final int COL_BG = 0xE61A1D23;
    private static final int COL_BTN = 0xFF2A303A;
    private static final int COL_OFF = 0xFFFF5D6C;
    private static final int COL_OK = 0xFF3DDC97;
    private static final int COL_WAIT = 0xFFF0B429;

    private WindowManager windowManager;
    private View overlayView;
    private WindowManager.LayoutParams params;
    private LinearLayout root;
    private TextView handle;
    private TextView micBtn;
    private TextView deafBtn;
    private TextView rangeView;
    private View[] extras = new View[0];

    private String displayName = "Proximity Voice";
    private String statusText = "Connected";
    private boolean muted = false;
    private boolean deafened = false;
    private boolean collapsed = false;
    private String rangeLabel = "\u2013";

    private boolean dragged = false;
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
            if (intent.hasExtra(EXTRA_RANGE)) {
                String r = intent.getStringExtra(EXTRA_RANGE);
                if (r != null && !r.isEmpty()) rangeLabel = r;
            }
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
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.HORIZONTAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        root.setPadding(dp(5), dp(5), dp(5), dp(5));
        root.setBackground(round(COL_BG, 22, 0x33FFFFFF));
        root.setElevation(dp(8));

        handle = circleBtn("\u25CF", 15);
        handle.setOnTouchListener(this::onDrag);

        micBtn = circleBtn("\uD83C\uDF99", 14);
        deafBtn = circleBtn("\uD83C\uDFA7", 14);
        TextView down = circleBtn("\u2212", 16);
        TextView up = circleBtn("+", 16);
        rangeView = new TextView(this);
        rangeView.setTextColor(0xFFFFFFFF);
        rangeView.setTextSize(13);
        rangeView.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        rangeView.setGravity(Gravity.CENTER);
        rangeView.setMinWidth(dp(30));
        rangeView.setText(rangeLabel);

        LinearLayout stepper = new LinearLayout(this);
        stepper.setOrientation(LinearLayout.HORIZONTAL);
        stepper.setGravity(Gravity.CENTER_VERTICAL);
        stepper.setBackground(round(COL_BTN, 20, 0));
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, dp(30));
        slp.setMargins(dp(2), 0, dp(2), 0);
        stepper.setLayoutParams(slp);
        down.setBackground(null);
        up.setBackground(null);
        stepper.addView(down);
        stepper.addView(rangeView);
        stepper.addView(up);

        TextView open = circleBtn("\u2197", 14);
        TextView close = circleBtn("\u2715", 12);

        micBtn.setOnClickListener(v -> sendBroadcastAction(ACTION_TOGGLE_MIC));
        deafBtn.setOnClickListener(v -> sendBroadcastAction(ACTION_TOGGLE_DEAF));
        down.setOnClickListener(v -> sendBroadcastAction(ACTION_RANGE_DOWN));
        up.setOnClickListener(v -> sendBroadcastAction(ACTION_RANGE_UP));
        open.setOnClickListener(v -> {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            startActivity(i);
        });
        close.setOnClickListener(v -> stopSelf());

        root.addView(handle);
        root.addView(micBtn);
        root.addView(deafBtn);
        root.addView(stepper);
        root.addView(open);
        root.addView(close);
        extras = new View[]{micBtn, deafBtn, stepper, open, close};

        root.setOnTouchListener(this::onDrag);
        return root;
    }

    private GradientDrawable round(int fill, int radiusDp, int stroke) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(radiusDp));
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }

    private GradientDrawable circle(int fill) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(fill);
        return g;
    }

    private TextView circleBtn(String label, int sp) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextSize(sp);
        t.setGravity(Gravity.CENTER);
        t.setTextColor(0xFFFFFFFF);
        t.setBackground(circle(COL_BTN));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(30), dp(30));
        lp.setMargins(dp(2), 0, dp(2), 0);
        t.setLayoutParams(lp);
        t.setClickable(true);
        t.setFocusable(true);
        return t;
    }

    /** Drag anywhere on the pill; a plain tap on the dot folds / unfolds it. */
    private boolean onDrag(View v, MotionEvent event) {
        int slop = ViewConfiguration.get(this).getScaledTouchSlop();
        switch (event.getAction()) {
            case MotionEvent.ACTION_DOWN:
                startX = params.x;
                startY = params.y;
                touchX = event.getRawX();
                touchY = event.getRawY();
                dragged = false;
                return true;
            case MotionEvent.ACTION_MOVE:
                float dx = event.getRawX() - touchX;
                float dy = event.getRawY() - touchY;
                if (Math.abs(dx) > slop || Math.abs(dy) > slop) dragged = true;
                if (dragged) {
                    params.x = startX + (int) dx;
                    params.y = startY + (int) dy;
                    if (overlayView != null) windowManager.updateViewLayout(overlayView, params);
                }
                return true;
            case MotionEvent.ACTION_UP:
                if (!dragged && v == handle) {
                    collapsed = !collapsed;
                    applyUi();
                }
                return true;
            default:
                return false;
        }
    }

    private void applyUi() {
        if (overlayView == null) return;
        boolean waiting = statusText != null && statusText.toLowerCase().contains("wait");
        boolean off = muted || deafened;
        if (handle != null) {
            handle.setTextColor(off ? COL_OFF : (waiting ? COL_WAIT : COL_OK));
        }
        if (micBtn != null) {
            micBtn.setText(off ? "\uD83D\uDD07" : "\uD83C\uDF99");
            micBtn.setBackground(circle(off ? COL_OFF : COL_BTN));
        }
        if (deafBtn != null) {
            deafBtn.setText(deafened ? "\uD83D\uDE49" : "\uD83C\uDFA7");
            deafBtn.setBackground(circle(deafened ? COL_OFF : COL_BTN));
        }
        if (rangeView != null) {
            rangeView.setText(rangeLabel != null && !rangeLabel.isEmpty() ? rangeLabel : "\u2013");
        }
        for (View x : extras) x.setVisibility(collapsed ? View.GONE : View.VISIBLE);
        if (root != null) {
            root.setAlpha(collapsed ? 0.8f : 0.96f);
            root.setPadding(dp(5), dp(5), dp(5), dp(5));
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
