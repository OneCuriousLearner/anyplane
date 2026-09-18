package run.anyplane;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.core.app.NotificationManagerCompat;
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
            // ApiClient.postJson：409 = 已在别处裁决，静默；2xx 成功；其余（含网络异常 -2）失败
            int code = -1;
            try {
                JSONObject body = new JSONObject()
                    .put("key", key)
                    .put("requestId", requestId)
                    .put("decision", decision);
                code = ApiClient.postJson(context, "/api/approvals/resolve", body);
                if (code > 0) {
                    android.util.Log.d("AnyPlaneAction", "裁决 POST 结果 http=" + code);
                }
            } catch (Exception ignored) {
                // 落入「未送达」通知
            } finally {
                boolean delivered = (code >= 200 && code < 300) || code == 409;
                if (!delivered) {
                    notifyUndelivered(context, requestId);
                }
                pending.finish();
            }
        }).start();
    }

    private static void notifyUndelivered(Context context, String requestId) {
        android.app.Notification n = new androidx.core.app.NotificationCompat.Builder(context, "approvals")
            // 品牌标（mipmap PNG；默认模板机器人在 simplify 轮已清）
            .setSmallIcon(R.mipmap.ic_launcher_foreground)
            .setContentTitle("审批未送达")
            .setContentText("请打开应用确认会话状态")
            .setAutoCancel(true)
            .build();
        NotificationManagerCompat.from(context).notify(ApprovalService.notifId(requestId), n);
    }
}
