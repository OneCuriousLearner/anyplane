package run.anyplane;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import androidx.core.app.NotificationManagerCompat;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

/**
 * 通知按钮裁决接收器。进程死了也能被广播拉起（exported=false + 显式 Intent），
 * 直接 POST /api/approvals/resolve——不依赖 WebView/JS 在场，这是冷启动裁决的主路径
 * （JS 侧的 ?nativeAction= 接力只服务 LocalNotifications 插件发出的通知）。
 * 409 = 已在别处裁决，静默；其余失败发一条「审批未送达」通知兜底。
 */
public class ApprovalActionReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String key = intent.getStringExtra("key");
        String requestId = intent.getStringExtra("requestId");
        String action = intent.getAction();
        if (key == null || requestId == null || action == null) return;
        final String decision = "approve".equals(action) ? "allow" : "deny";
        android.util.Log.d("AnyPlaneAction", "收到按钮裁决 " + decision + " requestId=" + requestId);
        NotificationManagerCompat.from(context).cancel(ApprovalService.notifId(requestId));

        final PendingResult pending = goAsync();
        new Thread(() -> {
            boolean delivered = false;
            try {
                SharedPreferences p = AnyPlaneBridgePlugin.prefs(context);
                String serverUrl = p.getString(AnyPlaneBridgePlugin.PREF_SERVER_URL, "");
                String token = p.getString(AnyPlaneBridgePlugin.PREF_TOKEN, "");
                String cookies = p.getString(AnyPlaneBridgePlugin.PREF_COOKIES, "");
                if (serverUrl != null && !serverUrl.isEmpty()) {
                    JSONObject body = new JSONObject()
                        .put("key", key)
                        .put("requestId", requestId)
                        .put("decision", decision);
                    Request.Builder rb = new Request.Builder()
                        .url(serverUrl + "/api/approvals/resolve")
                        .post(RequestBody.create(body.toString(), MediaType.get("application/json")));
                    if (token != null && !token.isEmpty()) {
                        rb.header("authorization", "Bearer " + token);
                    }
                    if (cookies != null && !cookies.isEmpty()) {
                        rb.header("Cookie", cookies);
                    }
                    try (Response r = new OkHttpClient().newCall(rb.build()).execute()) {
                        delivered = r.isSuccessful() || r.code() == 409;
                        android.util.Log.d("AnyPlaneAction", "裁决 POST 结果 http=" + r.code());
                    }
                }
            } catch (Exception ignored) {
                // 网络不可达等：落入「未送达」通知
            } finally {
                if (!delivered) {
                    notifyUndelivered(context, requestId);
                }
                pending.finish();
            }
        }).start();
    }

    private static void notifyUndelivered(Context context, String requestId) {
        android.app.Notification n = new androidx.core.app.NotificationCompat.Builder(context, "approvals")
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("审批未送达")
            .setContentText("请打开应用确认会话状态")
            .setAutoCancel(true)
            .build();
        NotificationManagerCompat.from(context).notify(ApprovalService.notifId(requestId), n);
    }
}
