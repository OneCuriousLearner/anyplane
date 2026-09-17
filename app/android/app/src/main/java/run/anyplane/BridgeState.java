package run.anyplane;

/**
 * 壳内共享状态。appInForeground：前台时页面内审批卡已覆盖，ApprovalService 不再重复发通知；
 * pendingOpenKey：点通知正文带回的会话 key，等 WebView 侧 JS 经 consumePendingOpen 取走。
 */
public final class BridgeState {
    private BridgeState() {}

    public static volatile boolean appInForeground = false;
    public static volatile String pendingOpenKey = null;
}
