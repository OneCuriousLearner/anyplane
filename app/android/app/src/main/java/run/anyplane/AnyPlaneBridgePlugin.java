package run.anyplane;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS ↔ 原生桥。configure 把服务器地址与令牌交给原生层并启动审批监听前台服务——
 * 令牌落 SharedPreferences，敏感度与 WebView localStorage 同级（设备本地，明文）；
 * Keystore 包装是已知的加固项。disable 清除并停服务。consumePendingOpen 取深链 key。
 */
@CapacitorPlugin(name = "AnyPlaneBridge")
public class AnyPlaneBridgePlugin extends Plugin {

    static final String PREFS = "anyplane.bridge";
    static final String PREF_SERVER_URL = "serverUrl";
    static final String PREF_TOKEN = "token";

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void configure(PluginCall call) {
        String serverUrl = call.getString("serverUrl", "").trim();
        while (serverUrl.endsWith("/")) {
            serverUrl = serverUrl.substring(0, serverUrl.length() - 1);
        }
        String token = call.getString("token", "");
        Context ctx = getContext();
        prefs(ctx).edit().putString(PREF_SERVER_URL, serverUrl).putString(PREF_TOKEN, token).apply();
        Log.d("AnyPlaneBridge", "configure: " + serverUrl + "（token " + (token.isEmpty() ? "无" : "有") + "），启动审批服务");
        ContextCompat.startForegroundService(ctx, new Intent(ctx, ApprovalService.class));
        call.resolve(new JSObject().put("ok", true));
    }

    @PluginMethod
    public void disable(PluginCall call) {
        Context ctx = getContext();
        prefs(ctx).edit().clear().apply();
        ctx.stopService(new Intent(ctx, ApprovalService.class));
        call.resolve();
    }

    @PluginMethod
    public void consumePendingOpen(PluginCall call) {
        JSObject r = new JSObject();
        if (BridgeState.pendingOpenKey != null) {
            r.put("key", BridgeState.pendingOpenKey);
            BridgeState.pendingOpenKey = null;
        }
        call.resolve(r);
    }

    /** 权限被永久拒绝时的出口：直达本应用的通知设置页（运行时请求已无法再弹） */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent i = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }
}
