package run.anyplane;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.concurrent.TimeUnit;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

/**
 * 原生网络栈共享装配（simplify 评审合并簇）：凭据读取（内存缓存，configure 时失效）
 * + 单例 OkHttpClient + 认证 POST 一处装配。
 * 此前 ApprovalService.connect/report、ApprovalActionReceiver、BootReceiver 四处各自
 * 「读 prefs → 判空 → 新建 client → 装 Bearer/Cookie 头」，且每次重连/遥测新建 client、
 * 每次访问都解密 Keystore——凭据字段加一项要穿四个点，header 改一处要改两遍。
 */
final class ApiClient {

    /** 已解密的当前凭据（serverUrl 明文；token/cookies 经 SecureStore 解密后缓存） */
    static final class Creds {
        final String serverUrl;
        final String token;
        final String cookies;

        Creds(String serverUrl, String token, String cookies) {
            this.serverUrl = serverUrl;
            this.token = token;
            this.cookies = cookies;
        }

        boolean hasServer() {
            return !serverUrl.isEmpty();
        }
    }

    private static volatile Creds cached;

    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build();

    private ApiClient() {}

    /** 当前凭据（内存缓存；configureNative 写入后必须 invalidate） */
    static Creds creds(Context ctx) {
        Creds c = cached;
        if (c == null) {
            SharedPreferences p = AnyPlaneBridgePlugin.prefs(ctx);
            c = new Creds(
                str(p.getString(AnyPlaneBridgePlugin.PREF_SERVER_URL, "")),
                SecureStore.getSecret(p, AnyPlaneBridgePlugin.PREF_TOKEN),
                SecureStore.getSecret(p, AnyPlaneBridgePlugin.PREF_COOKIES)
            );
            cached = c;
        }
        return c;
    }

    /** configureNative 写入凭据后调用：下次 creds() 重新读取解密 */
    static void invalidate() {
        cached = null;
    }

    static OkHttpClient http() {
        return HTTP;
    }

    /**
     * 认证 POST（Bearer + Cookie 按需装配）。serverUrl 为空返回 -1；
     * 返回 HTTP 状态码，网络异常返回 -2（调用方自行决定语义：409 静默/未送达通知等）。
     */
    static int postJson(Context ctx, String path, JSONObject body) {
        Creds c = creds(ctx);
        if (!c.hasServer()) return -1;
        Request.Builder rb = new Request.Builder()
            .url(c.serverUrl + path)
            .post(RequestBody.create(body.toString(), MediaType.get("application/json")));
        if (!c.token.isEmpty()) rb.header("authorization", "Bearer " + c.token);
        if (!c.cookies.isEmpty()) rb.header("Cookie", c.cookies);
        try (Response r = HTTP.newCall(rb.build()).execute()) {
            return r.code();
        } catch (Exception e) {
            return -2;
        }
    }

    private static String str(String s) {
        return s == null ? "" : s;
    }
}
