package run.anyplane;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
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

    private final Handler handler = new Handler(Looper.getMainLooper());
    /** requestId → 事件原文（前台期间挂账的 pending 审批）。
     *  synchronizedMap 包裹：OkHttp 读线程改、主线程（onForegroundChanged）遍历，
     *  遍历段必须再套 synchronized(pendings)（评审发现的并发修改竞态） */
    private final Map<String, JSONObject> pendings = java.util.Collections.synchronizedMap(new LinkedHashMap<>());
    private WebSocket ws;
    private volatile boolean wsOpen = false;
    private int retryDelaySec = 1;
    private volatile boolean stopped = false;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        // NotificationChannel 是 API 26+ 的类（minSdk 24：24/25 设备上引用即
        // NoClassDefFoundError，服务永远起不来——评审发现）；26 以下无渠道概念直接发
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.createNotificationChannel(
                new NotificationChannel(CHANNEL_APPROVAL, "审批请求", NotificationManager.IMPORTANCE_HIGH)
            );
            nm.createNotificationChannel(
                new NotificationChannel(CHANNEL_CONN, "连接状态", NotificationManager.IMPORTANCE_MIN)
            );
        }
        BridgeState.foregroundListener = this::onForegroundChanged;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        stopped = false;
        boolean credsChanged = intent == null || intent.getBooleanExtra("credsChanged", true);
        // 凭据未变且连接健康时跳过重连——此前每次回前台都拆一条健康 WS 再重建
        //（握手 churn + snapshot 重拉，simplify 评审 Efficiency 发现）
        if (wsOpen && !credsChanged) {
            updateOngoing("已连接");
            return START_STICKY;
        }
        updateOngoing("连接中…");
        connect();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopped = true;
        wsOpen = false;
        BridgeState.foregroundListener = null;
        handler.removeCallbacksAndMessages(null);
        if (ws != null) {
            ws.close(1000, "service stop");
            ws = null;
        }
        // 注意：OkHttpClient 是 ApiClient 的共享单例，不归本服务关闭
        super.onDestroy();
    }

    private void connect() {
        ApiClient.Creds creds = ApiClient.creds(this);
        if (!creds.hasServer()) {
            Log.w(TAG, "未配置服务器地址，服务退出");
            stopSelf();
            return;
        }
        String wsUrl = creds.serverUrl.replaceFirst("^http", "ws") + "/ws/inbox"
            + (creds.token.isEmpty() ? "" : "?token=" + URLEncoder.encode(creds.token, StandardCharsets.UTF_8));
        Log.d(TAG, "连接 " + creds.serverUrl + "（token " + (creds.token.isEmpty() ? "无" : "有") + "）");
        Request.Builder rb = new Request.Builder().url(wsUrl);
        if (!creds.cookies.isEmpty()) {
            // SSO 网关路径：WebView 摘来的会话 cookie（configure 时写入）
            rb.header("Cookie", creds.cookies);
        }
        // 防御双连：onStartCommand 可被重复投递（STICKY 重投/多次 start），旧连接先收掉
        if (ws != null) {
            ws.close(1000, "reconnect");
        }
        ws = ApiClient.http().newWebSocket(rb.build(), new Listener());
    }

    /** 原生侧遥测：WS 生命周期/失败原因上报 /api/client-log（尽力而为，不阻塞主链） */
    private void report(String tag, String msg) {
        new Thread(() -> {
            try {
                ApiClient.postJson(this, "/api/client-log", new JSONObject().put("tag", tag).put("msg", msg));
            } catch (Exception ignored) {
                // 上报通道本身不可达时静默（主链日志仍在 logcat）
            }
        }).start();
    }

    private void scheduleReconnect() {
        wsOpen = false;
        if (stopped) return;
        updateOngoing("连接断开，重连中…");
        int delay = retryDelaySec;
        retryDelaySec = Math.min(retryDelaySec * 2, 30);
        Log.d(TAG, delay + "s 后重连");
        handler.postDelayed(this::connect, delay * 1000L);
    }

    private void onForegroundChanged() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        // 遍历段加锁：与 OkHttp 读线程的 put/remove/快照替换互斥（评审发现）
        synchronized (pendings) {
            if (BridgeState.appInForeground) {
                // 回前台：页面审批卡接管，清掉本服务发出的审批通知
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
    }

    private final class Listener extends WebSocketListener {
        // 迟到事件防护：双连防御/重连会主动关掉旧 socket——旧 socket 的回调不得再
        // 武装重连或更新状态（否则两个 socket 每秒互相顶掉，自激循环：评审发现）
        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            if (webSocket != ws) {
                webSocket.close(1000, "stale");
                return;
            }
            retryDelaySec = 1;
            wsOpen = true;
            Log.d(TAG, "inbox 已连接");
            updateOngoing("已连接");
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            if (webSocket != ws) return;
            handleEvent(text);
        }

        @Override
        public void onClosing(WebSocket webSocket, int code, String reason) {
            webSocket.close(1000, null);
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            if (webSocket != ws) return;
            Log.d(TAG, "连接关闭 code=" + code);
            report("svc-ws-closed", "code=" + code + " reason=" + reason);
            scheduleReconnect();
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, Response response) {
            if (webSocket != ws) return;
            Log.w(TAG, "连接失败: " + t + (response != null ? " http=" + response.code() : ""));
            report("svc-ws-fail", String.valueOf(t) + (response != null ? " http=" + response.code() : ""));
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
                // snapshot 是当前 pending 的权威全集：整体替换——断连期间在别处被裁决的
                // 陈账必须清掉，否则切后台时被当成还活着的审批复活（评审发现）
                JSONArray arr = ev.optJSONArray("approvals");
                synchronized (pendings) {
                    pendings.clear();
                    if (arr != null) {
                        for (int i = 0; i < arr.length(); i++) {
                            JSONObject a = arr.getJSONObject(i);
                            String requestId = a.optString("requestId", "");
                            if (!requestId.isEmpty()) pendings.put(requestId, a);
                        }
                    }
                    for (JSONObject a : pendings.values()) {
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
        // requestCode 加盐再哈希：notifId*2 在 id>=0x40000000 时整型溢出，不同审批会撞车
        PendingIntent approvePi = actionIntent("approve", key, requestId, requestCode(requestId, "approve"));
        PendingIntent denyPi = actionIntent("deny", key, requestId, requestCode(requestId, "deny"));

        Intent open = new Intent(this, MainActivity.class)
            .putExtra("anyplane.openKey", key)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPi = PendingIntent.getActivity(
            this, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification n = new NotificationCompat.Builder(this, CHANNEL_APPROVAL)
            // 品牌标（mipmap PNG；默认模板机器人在 simplify 轮已清）
            .setSmallIcon(R.mipmap.ic_launcher_foreground)
            .setContentTitle("审批 · " + toolName)
            .setContentText(approvalBody(ev))
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
            // 品牌标（mipmap PNG；默认模板机器人在 simplify 轮已清）
            .setSmallIcon(R.mipmap.ic_launcher_foreground)
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

    /** 服务端 detail 正本；老服务端缺省时回退本地截断（与 nativeBridge 同口径） */
    static String approvalBody(JSONObject ev) {
        String detail = ev.optString("detail", "").trim();
        if (!detail.isEmpty()) return detail;
        return summarize(ev.opt("input"));
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

    /** PendingIntent requestCode：加盐再折 31 位，避免 notifId*2 溢出撞车 */
    static int requestCode(String requestId, String purpose) {
        return notifId(requestId + '\0' + purpose);
    }
}
