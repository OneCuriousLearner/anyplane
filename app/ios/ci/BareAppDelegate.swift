import UIKit
import UserNotifications

// 裸应用判别器：零 Capacitor，纯 UNUserNotification 注册同款 APPROVAL category
// （批准/拒绝两个 action）+ 延迟 12s 触发同款测试通知。
// 若裸应用在 iOS 26 ShortLook 上同样渲染不出 action 按钮 → 平台回归实锤；
// 若裸应用能渲染 → 问题在 Capacitor 插件，按 ROADMAP 预案补原生 delegate。
@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let approve = UNNotificationAction(identifier: "approve", title: "批准", options: [])
        let deny = UNNotificationAction(identifier: "deny", title: "拒绝", options: [.destructive])
        let category = UNNotificationCategory(identifier: "APPROVAL", actions: [approve, deny], intentIdentifiers: [])
        let center = UNUserNotificationCenter.current()
        center.setNotificationCategories([category])
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }

        let content = UNMutableNotificationContent()
        content.title = "审批 · CI-Test"
        content.body = "bare discriminator"
        content.categoryIdentifier = "APPROVAL"
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 12, repeats: false)
        center.add(UNNotificationRequest(identifier: "bare-1", content: content, trigger: trigger))

        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = UIViewController()
        window?.makeKeyAndVisible()
        return true
    }
}
