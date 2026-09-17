package run.anyplane;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;
import androidx.core.content.ContextCompat;

/**
 * 开机自启审批监听服务。仅当用户配置过服务器地址才拉起（未配置=从未完成引导，不拉）。
 * Android 12+ 后台启动 FGS 受限：BOOT_COMPLETED 对 dataSync 类型在豁免清单内，
 * 但各 ROM 落地不一，失败只记日志不崩——下次打开 app 时 configure 会再拉。
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        SharedPreferences p = AnyPlaneBridgePlugin.prefs(context);
        String serverUrl = p.getString(AnyPlaneBridgePlugin.PREF_SERVER_URL, "");
        if (serverUrl == null || serverUrl.isEmpty()) {
            Log.d("AnyPlaneBoot", "未配置服务器地址，开机不自启");
            return;
        }
        try {
            ContextCompat.startForegroundService(context, new Intent(context, ApprovalService.class));
            Log.d("AnyPlaneBoot", "开机拉起审批服务");
        } catch (Exception e) {
            Log.w("AnyPlaneBoot", "开机拉起失败（ROM 限制？）: " + e);
        }
    }
}
