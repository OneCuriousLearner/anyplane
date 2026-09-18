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
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS ↔ 原生桥，单一通道：anyplane-bridge://<method>?<query> 导航拦截（shouldOverrideLoad）。
 * 纯页面导航，任何 WebView 都可用——选它的原因：vivo OriginOS 的 WebView 对远端页
 * （hosted 模式）整段废除 addJavascriptInterface（实机：一切插件调用永 pending，
 * 系统权限弹窗从未出现），标准 Capacitor JSI 插件方法因此整体不可用并已移除。
 * 返回路径（native→JS）一律用 WebView.evaluateJavascript——与 JSI 无关的独立机制。
 * 令牌与 cookie 落 SharedPreferences，敏感度与 WebView localStorage 同级（设备本地）。
 */
@CapacitorPlugin(name = "AnyPlaneBridge")
public class AnyPlaneBridgePlugin extends Plugin {

    private static final String TAG = "AnyPlaneBridge";
    static final String PREFS = "anyplane.bridge";
    static final String PREF_SERVER_URL = "serverUrl";
    static final String PREF_TOKEN = "token";
    static final String PREF_COOKIES = "cookies";
    static final int REQ_POST_NOTIFICATIONS = 42;

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ---------- 通道 ②：导航拦截 ----------

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (url == null) return null;
        if ("anyplane-bridge".equals(url.getScheme())) {
            String method = String.valueOf(url.getHost());
            Log.d(TAG, "导航桥调用: " + method);
            if ("configure".equals(method)) {
                configureNative(
                    safe(url.getQueryParameter("serverUrl")),
                    safe(url.getQueryParameter("token"))
                );
            } else if ("openNotificationSettings".equals(method)) {
                openSettings();
            } else if ("requestBatteryExemption".equals(method)) {
                requestBatteryExemption();
            }
            return true;
        }
        // 导航白名单（spike 期 allowNavigation ['*'] 的收紧；插件判定优先于 mask）：
        // 本地源与「和已配置服务器同源（scheme+host+port 全等）」的地址可在壳内加载，
        // 其余一律甩外部浏览器——只比 host 会把同主机任意端口/明文服务放进带桥的壳
        // （评审发现：同 host 异端口页面可借 anyplane-bridge:// 重指审批服务）。
        // 已知限制：SSO 前置部署的交互式登录跳转也会被甩到外部浏览器。
        String scheme = url.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme)) return null; // data/blob 等交默认处理
        if ("localhost".equals(url.getHost())) return false;
        SharedPreferences p = prefs(getContext());
        String serverUrl = p.getString(PREF_SERVER_URL, "");
        if (serverUrl == null || serverUrl.isEmpty()) return false; // 引导期全放行
        if (sameOrigin(Uri.parse(serverUrl), url)) return false;
        try {
            getContext().startActivity(
                new Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            );
        } catch (Exception ignored) {
            // 无浏览器可接时静默吞掉
        }
        return true;
    }

    /** scheme+host+port 全等才算同源（端口做 80/443 默认归一） */
    private static boolean sameOrigin(Uri server, Uri url) {
        return server.getScheme().equals(url.getScheme())
            && server.getHost().equals(url.getHost())
            && effectivePort(server) == effectivePort(url);
    }

    private static int effectivePort(Uri u) {
        int p = u.getPort();
        if (p != -1) return p;
        return "https".equals(u.getScheme()) ? 443 : 80;
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
        // 摘 WebView cookie 供原生网络栈使用：服务端地址若在企业 SSO 网关之后
        // （如内网统一认证），WebView 持 SSO 会话而 OkHttp cookie 罐为空——
        // 原生 WS/POST 会被网关弹回（实机：常驻通知卡「重连中」）。
        String cookies = "";
        try {
            String c = android.webkit.CookieManager.getInstance().getCookie(serverUrl);
            if (c != null) cookies = c;
        } catch (Exception ignored) {
            // WebView 尚未就绪等场景：留空，按无 cookie 连
        }
        SharedPreferences sp = prefs(ctx);
        String oldUrl = sp.getString(PREF_SERVER_URL, "");
        boolean serverChanged = !serverUrl.equals(oldUrl);
        sp.edit().putString(PREF_SERVER_URL, serverUrl).apply();
        // token/cookie 走 Keystore 包装。只在拿到非空新值或换了服务器时才覆盖：
        // WebView 未就绪（getCookie 空）/登录前（token 空）的瞬态不得冲掉有效凭据
        // （评审发现：一次瞬态空写就把 SSO 会话与 token 全清，重连中循环）
        if (serverChanged || !token.isEmpty()) SecureStore.putSecret(sp, PREF_TOKEN, token);
        if (serverChanged || !cookies.isEmpty()) SecureStore.putSecret(sp, PREF_COOKIES, cookies);
        Log.d(TAG, "configure: " + serverUrl + "（token " + (token.isEmpty() ? "无" : "有")
            + "，cookie " + (cookies.isEmpty() ? "无" : "有") + "），启动审批服务");
        ContextCompat.startForegroundService(ctx, new Intent(ctx, ApprovalService.class));
        ensureNotificationPermission();
    }

    /** 权限请求原生直发：JSI 已废的设备上，这是系统弹窗唯一能出现的路径 */
    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // API<33 无运行时权限：真实开关在系统设置里（评审发现——用户在设置里关掉
            // 通知会被误报 granted，重演静默死）
            boolean enabled = androidx.core.app.NotificationManagerCompat
                .from(getContext()).areNotificationsEnabled();
            pushPermState(enabled ? "granted" : "denied");
            return;
        }
        boolean granted = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        // 33+ 运行时权限与总开关联动，但以 areNotificationsEnabled 为准（渠道级关闭也算没开）
        boolean enabled = androidx.core.app.NotificationManagerCompat
            .from(getContext()).areNotificationsEnabled();
        if (granted && enabled) {
            pushPermState("granted");
            return;
        }
        if (granted) {
            // 有运行时权限但总开关/渠道被关：弹窗无意义，直送设置页
            pushPermState("denied");
            openSettings();
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

    /** 电池优化豁免：国产 ROM 后台省电会掐前台服务的长连 socket（实机 RST 确诊），
     *  侧载分发不走 Play 审核，ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS 合规可用 */
    private void requestBatteryExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        Intent i = new Intent(
            android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:" + getContext().getPackageName())
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
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
}
