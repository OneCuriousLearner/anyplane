package run.anyplane;

/**
 * 壳内共享状态（同进程内存通信，Activity 与 Service 不需要 IPC）。
 * appInForeground：前台时页面内审批卡已覆盖，ApprovalService 不重复发通知；
 * pendingOpenKey：点通知正文带回的会话 key。本地引导页只挂 window.__anyplanePendingOpen
 * 由 index.html 接到远端 #s=；已在远端源时直接推 location.hash。
 * setForeground 会同步回调服务注册的 listener——前后台切换时补发/清掉审批通知：
 * 前台期间到达的审批事件只是挂账（pendings），切后台一刻必须补发，否则锁屏后永远没有通知。
 */
public final class BridgeState {
    private BridgeState() {}

    public static volatile boolean appInForeground = false;
    public static volatile String pendingOpenKey = null;
    public static Runnable foregroundListener = null;

    public static void setForeground(boolean foreground) {
        appInForeground = foreground;
        Runnable r = foregroundListener;
        if (r != null) {
            r.run();
        }
    }
}
