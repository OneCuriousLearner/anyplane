package run.anyplane;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 应用内自定义插件需在 bridge 初始化前注册
        registerPlugin(AnyPlaneBridgePlugin.class);
        super.onCreate(savedInstanceState);
        captureOpenKey(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        captureOpenKey(intent);
    }

    /** 点通知正文带回的会话 key：暂存，等 WebView 侧 JS 经 consumePendingOpen 取走深链 */
    private void captureOpenKey(Intent intent) {
        if (intent == null) return;
        String key = intent.getStringExtra("anyplane.openKey");
        if (key != null) {
            BridgeState.pendingOpenKey = key;
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
