package run.anyplane;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 应用内自定义插件需在 bridge 初始化前注册
        registerPlugin(AnyPlaneBridgePlugin.class);
        super.onCreate(savedInstanceState);
        captureOpenKey(getIntent());
        // 点通知正文带回的深链：页面加载完成后经 evaluateJavascript 冲刷
        // （JSI 在部分国产 ROM 上不可用，evaluateJavascript 是独立机制）
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                flushPendingOpen();
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        captureOpenKey(intent);
        flushPendingOpen();
    }

    /** 点通知正文带回的会话 key：先进缓冲，等页面在的时候经 evaluateJavascript 推 hash 深链 */
    private void captureOpenKey(Intent intent) {
        if (intent == null) return;
        String key = intent.getStringExtra("anyplane.openKey");
        if (key != null) {
            BridgeState.pendingOpenKey = key;
        }
    }

    private void flushPendingOpen() {
        final String key = BridgeState.pendingOpenKey;
        if (key == null || getBridge() == null || getBridge().getWebView() == null) return;
        String url = getBridge().getWebView().getUrl();
        if (isLocalShell(url)) {
            // 引导页跨源 replace 会丢掉 hash：挂到全局，由 www/index.html 接到远端 URL。
            // 不清 pendingOpenKey——远端 onPageLoaded 再推 hash 作双保险。
            evalOnWebView("window.__anyplanePendingOpen=" + jsString(key));
            return;
        }
        BridgeState.pendingOpenKey = null;
        // JSONObject.quote 才是 JS 字符串上下文；Uri.encode 放行单引号，exported Activity extras 可注入
        evalOnWebView("location.hash='#s='+encodeURIComponent(" + jsString(key) + ")");
    }

    /** Capacitor 本地源（引导页）。null/空/无 host 也当本地，避免在未知页上清掉 pending。 */
    static boolean isLocalShell(String url) {
        if (url == null || url.isEmpty()) return true;
        String host = Uri.parse(url).getHost();
        if (host == null) return true;
        return "localhost".equalsIgnoreCase(host) || "127.0.0.1".equals(host);
    }

    /** JS 字符串字面量（含引号）。不要用 Uri.encode：它放行 '()* ，会破出单引号拼接。 */
    static String jsString(String value) {
        return JSONObject.quote(value == null ? "" : value);
    }

    /** native→JS 的统一出口（插件的状态回推也走这里） */
    void evalOnWebView(final String js) {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        getBridge().getWebView().post(() -> getBridge().getWebView().evaluateJavascript(js, null));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == AnyPlaneBridgePlugin.REQ_POST_NOTIFICATIONS) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            AnyPlaneBridgePlugin.pushPermState(this, granted ? "granted" : "denied");
            // 服务在 configure 时已启动，授权仅影响通知可见性，无需额外动作
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        BridgeState.setForeground(true);
    }

    @Override
    public void onPause() {
        super.onPause();
        BridgeState.setForeground(false);
    }
}
