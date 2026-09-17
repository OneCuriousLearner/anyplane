package run.anyplane;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 审批监听前台服务：自持 /ws/inbox WebSocket，审批事件落原生通知（批准/拒绝按钮）。
 * 存在理由：WebView 挂起后 JS 停摆，页面驱动的本地通知在锁屏/切走后不可靠（实机实测）——
 * 锁屏审批是核心卖点，必须由原生层常驻。START_STICKY 争取被系统重启；
 * OEM 激进清理（小米/华为等）仍需用户手动加白，这是已知边界。
 * 事件协议与 web/src/lib/inbox.ts 同形；裁决走 POST /api/approvals/resolve（Bearer）。
 *
 * 前台静默语义：事件到达时 app 在前台 → 只挂账 pendings（页面审批卡覆盖）；
 * 切后台一刻把 pendings 补发为通知（否则事件在前台被吞、锁屏后永远没有通知——
 * 首轮实机的真实 bug）；切回前台清掉本服务发出的审批通知。
 */
public class ApprovalService extends Service {

    private static final String TAG = "AnyPlaneSvc";
    private static final String CHANNEL_CONN = "connection";
    private static final String CHANNEL_APPROVAL = "approvals";
    private static final int ONGOING_ID = 1;

    private final OkHttpClient http = new OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build();
    private final Handler handler = new Handler(Looper.getMainLooper());
    /** requestId → 事件原文（前台期间挂账的 pending 审批） */
    private final Map<String, JSONObject> pendings = new LinkedHashMap<>();
    private WebSocket ws;
    private int retryDelaySec = 1;
    private volatile boolean stopped = false;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(
            new NotificationChannel(CHANNEL_APPROVAL, "审批请求", NotificationManager.IMPORTANCE_HIGH)
        );
        nm.createNotificationChannel(
            new NotificationChannel(CHANNEL_CONN, "连接状态", NotificationManager.IMPORTANCE_MIN)
        );
        BridgeState.foregroundListener = this::onForegroundChanged;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        stopped = false;
        updateOngoing("连接中…");
        connect();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopped = true;
        BridgeState.foregroundListener = null;
        handler.removeCallbacksAndMessages(null);
        if (ws != null) {
            ws.close(1000, "service stop");
            ws = null;
        }
        http.dispatcher().executorService().shutdown();
        super.onDestroy();
    }

    private void connect() {
        SharedPreferences p = AnyPlaneBridgePlugin.prefs(this);
        String serverUrl = p.getString(AnyPlaneBridgePlugin.PREF_SERVER_URL, "");
        String token = p.getString(AnyPlaneBridgePlugin.PREF_TOKEN, "");
        if (serverUrl == null || serverUrl.isEmpty()) {
            Log.w(TAG, "未配置服务器地址，服务退出");
            stopSelf();
            return;
        }
        String wsUrl = serverUrl.replaceFirst("^http", "ws") + "/ws/inbox"
            + (token == null || token.isEmpty() ? "" : "?token=" + URLEncoder.encode(token, StandardCharsets.UTF_8));
        Log.d(TAG, "连接 " + serverUrl + "（token " + (token == null || token.isEmpty() ? "无" : "有") + "）");
        ws = http.newWebSocket(new Request.Builder().url(wsUrl).build(), new Listener());
    }

    private void scheduleReconnect() {
        if (stopped) return;
        updateOngoing("连接断开，重连中…");
        int delay = retryDelaySec;
        retryDelaySec = Math.min(retryDelaySec * 2, 30);
        Log.d(TAG, delay + "s 后重连");
        handler.postDelayed(this::connect, delay * 1000L);
    }

    private void onForegroundChanged() {
        if (BridgeState.appInForeground) {
            // 回前台：页面审批卡接管，清掉本服务发出的审批通知
            NotificationManager nm = getSystemService(NotificationManager.class);
            for (String requestId : pendings.keySet()) {
                nm.cancel(notifId(requestId));
            }
        } else {
            // 切后台/锁屏：补发前台期间挂账的审批
            for (JSONObject ev : pendings.values()) {
                postApproval(ev);
            }
        }
    }

    private final class Listener extends WebSocketListener {
        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            retryDelaySec = 1;
            Log.d(TAG, "inbox 已连接");
            updateOngoing("已连接");
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            handleEvent(text);
        }

        @Override
        public void onClosing(WebSocket webSocket, int code, String reason) {
            webSocket.close(1000, null);
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            Log.d(TAG, "连接关闭 code=" + code);
            scheduleReconnect();
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, Response response) {
            Log.w(TAG, "连接失败: " + t + (response != null ? " http=" + response.code() : ""));
            scheduleReconnect();
        }
    }

    /** 与 web/src/lib/inbox.ts 的 InboxEvent 同形；未知 type 忽略（宽松解析同后端原则） */
    private void handleEvent(String text) {
        try {
            JSONObject ev = new JSONObject(text);
            String type = ev.optString("type");
            if ("approval".equals(type)) {
                String requestId = ev.optString("requestId", "");
                if (!requestId.isEmpty()) pendings.put(requestId, ev);
                postApproval(ev);
            } else if ("approval_resolved".equals(type)) {
                String requestId = ev.optString("requestId", "");
                pendings.remove(requestId);
                cancelApproval(requestId);
            } else if ("snapshot".equals(type)) {
                // 服务重启/重连后补发 pending 审批（notify 同 id 即覆盖，天然去重）
                JSONArray arr = ev.optJSONArray("approvals");
                if (arr != null) {
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject a = arr.getJSONObject(i);
                        String requestId = a.optString("requestId", "");
                        if (!requestId.isEmpty()) pendings.put(requestId, a);
                        postApproval(a);
                    }
                }
                Log.d(TAG, "snapshot：pending 审批 " + pendings.size() + " 条");
            }
        } catch (Exception ignored) {
            // 坏帧不值得杀连接
        }
    }

    private void postApproval(JSONObject ev) {
        String requestId = ev.optString("requestId", "");
        String key = ev.optString("key", "");
        if (requestId.isEmpty() || key.isEmpty()) return;
        if (BridgeState.appInForeground) {
            Log.d(TAG, "前台挂账审批 requestId=" + requestId);
            return;
        }
        String toolName = ev.optString("toolName", "?");
        Log.d(TAG, "发审批通知 " + toolName + " requestId=" + requestId);

        int id = notifId(requestId);
        PendingIntent approvePi = actionIntent("approve", key, requestId, id * 2);
        PendingIntent denyPi = actionIntent("deny", key, requestId, id * 2 + 1);

        Intent open = new Intent(this, MainActivity.class)
            .putExtra("anyplane.openKey", key)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPi = PendingIntent.getActivity(
            this, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification n = new NotificationCompat.Builder(this, CHANNEL_APPROVAL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("审批 · " + toolName)
            .setContentText(summarize(ev.opt("input")))
            .setContentIntent(openPi)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .addAction(0, "批准", approvePi)
            .addAction(0, "拒绝", denyPi)
            .build();
        getSystemService(NotificationManager.class).notify(id, n);
    }

    private void cancelApproval(String requestId) {
        if (requestId.isEmpty()) return;
        getSystemService(NotificationManager.class).cancel(notifId(requestId));
    }

    private PendingIntent actionIntent(String action, String key, String requestId, int requestCode) {
        Intent i = new Intent(this, ApprovalActionReceiver.class)
            .setAction(action)
            .putExtra("key", key)
            .putExtra("requestId", requestId);
        return PendingIntent.getBroadcast(
            this, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private void updateOngoing(String state) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent openPi = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Notification n = new NotificationCompat.Builder(this, CHANNEL_CONN)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("AnyPlane")
            .setContentText(state)
            .setContentIntent(openPi)
            .setOngoing(true)
            .build();
        ServiceCompat.startForeground(
            this, ONGOING_ID, n,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        );
    }

    private static String summarize(Object input) {
        String s = input == null ? "" : (input instanceof String ? (String) input : input.toString());
        return s.length() > 120 ? s.substring(0, 120) + "…" : s;
    }

    /** 与 web 侧 nativeBridge.notifId 同一 FNV-1a 折叠（跨层 id 口径一致） */
    static int notifId(String s) {
        int h = 0x811c9dc5;
        for (int i = 0; i < s.length(); i++) {
            h ^= s.charAt(i);
            h *= 0x01000193;
        }
        return h & 0x7fffffff;
    }
}
