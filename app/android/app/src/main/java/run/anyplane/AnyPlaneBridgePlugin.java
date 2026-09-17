package run.anyplane;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS ↔ 原生桥。两条通道：
 *
 * ① JSI（configure/consumePendingOpen/openNotificationSettings 的 PluginMethod）——
 *    标准 Capacitor 通道，在 vivo OriginOS 的 WebView 上对远端页整体失效（实机：
 *    一切插件调用永 pending，权限弹窗从未出现）。
 * ② 导航拦截（anyplane-bridge://<method>?<query>，经 shouldOverrideLoad）——
 *    纯页面导航，任何 WebView 都可用。JS 侧 location.href 触发，被本方法吞掉执行。
 *    vivo 实机的生产通道（见 web/src/lib/nativeBridge.ts 的 nav 段）。
 *
 * 返回路径（native→JS）一律用 WebView.evaluateJavascript——与 JSI 无关的独立机制。
 * 令牌落 SharedPreferences，敏感度与 WebView localStorage 同级（设备本地，明文）。
 */
@CapacitorPlugin(name = "AnyPlaneBridge")
public class AnyPlaneBridgePlugin extends Plugin {

    private static final String TAG = "AnyPlaneBridge";
    static final String PREFS = "anyplane.bridge";
    static final String PREF_SERVER_URL = "serverUrl";
    static final String PREF_TOKEN = "token";
    static final int REQ_POST_NOTIFICATIONS = 42;

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ---------- 通道 ②：导航拦截 ----------

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (url == null || !"anyplane-bridge".equals(url.getScheme())) return null;
        String method = String.valueOf(url.getHost());
        Log.d(TAG, "导航桥调用: " + method);
        if ("configure".equals(method)) {
            configureNative(
                safe(url.getQueryParameter("serverUrl")),
                safe(url.getQueryParameter("token"))
            );
        } else if ("openNotificationSettings".equals(method)) {
            openSettings();
        }
        return true;
    }

    private static String safe(String s) {
        return s == null ? "" : s;
    }

    private void configureNative(String serverUrl, String token) {
        serverUrl = serverUrl.trim();
        while (serverUrl.endsWith("/")) {
            serverUrl = serverUrl.substring(0, serverUrl.length() - 1);
        }
        Context ctx = getContext();
        prefs(ctx).edit().putString(PREF_SERVER_URL, serverUrl).putString(PREF_TOKEN, token).apply();
        Log.d(TAG, "configure: " + serverUrl + "（token " + (token.isEmpty() ? "无" : "有") + "），启动审批服务");
        ContextCompat.startForegroundService(ctx, new Intent(ctx, ApprovalService.class));
        ensureNotificationPermission();
    }

    /** 权限请求原生直发：JSI 已废的设备上，这是系统弹窗唯一能出现的路径 */
    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            pushPermState("granted");
            return;
        }
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            pushPermState("granted");
            return;
        }
        ActivityCompat.requestPermissions(
            getActivity(),
            new String[] { Manifest.permission.POST_NOTIFICATIONS },
            REQ_POST_NOTIFICATIONS
        );
        // 结果回 MainActivity.onRequestPermissionsResult → pushPermState
    }

    private void openSettings() {
        Intent i = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
    }

    /** native→JS 状态回推（evaluateJavascript 与 JSI 是两条独立机制，JSI 废了它也能用） */
    static void pushPermState(android.app.Activity activity, String display) {
        String js = "window.__anyplaneNativeEvent&&window.__anyplaneNativeEvent("
            + "{\"type\":\"perm\",\"display\":\"" + display + "\"})";
        if (activity instanceof MainActivity) {
            ((MainActivity) activity).evalOnWebView(js);
        }
    }

    private void pushPermState(String display) {
        pushPermState(getActivity(), display);
    }

    // ---------- 通道 ①：JSI（在通道正常的 WebView 上保留） ----------

    @PluginMethod
    public void configure(PluginCall call) {
        configureNative(safe(call.getString("serverUrl")), safe(call.getString("token")));
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
        openSettings();
        call.resolve();
    }
}
