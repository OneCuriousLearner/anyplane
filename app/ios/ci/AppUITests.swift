import XCTest

// iOS simulator spike：通知 action 全链验证。
// 被测应用由 CI 以 server.url=http://127.0.0.1:7480/?testNotify=1 构建：
// 页面加载后 3s 调度「审批 · CI-Test」本地通知（批准/拒绝两个 action），
// 本用例完成权限弹窗授权 → 退到桌面 → 通知中心点「批准」，
// 裁决 POST 是否到达桩服务器由 CI shell 侧断言（/tmp/resolve.log 含 ci-test-1）。
final class AppUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testApprovalNotificationAction() throws {
        // 显式 bundle id 起宿主（TargetApplication 属性在手工注入的工程里不可靠，
        // 报 "No target application path specified"——用 bundle id 最稳）
        let app = XCUIApplication(bundleIdentifier: "run.anyplane")
        app.launch()

        // 通知权限弹窗（iOS 16+ 系统 alert 在 SpringBoard 进程）
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 10) {
            allow.tap()
        }

        // 等页面加载 + 授权落地 + 钩子调度（钩子会等 granted 后才 schedule）
        sleep(10)

        // 退回桌面，拉出通知中心
        XCUIDevice.shared.press(.home)
        sleep(2)
        let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.01))
        let bottom = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        top.press(forDuration: 0.05, thenDragTo: bottom)
        sleep(2)

        // 找到测试通知并长按展开操作
        let notification = springboard.staticTexts["审批 · CI-Test"]
        XCTAssertTrue(notification.waitForExistence(timeout: 40), "测试通知未出现在通知中心")
        notification.press(forDuration: 1.2)
        sleep(1)

        let approve = springboard.buttons["批准"]
        XCTAssertTrue(approve.waitForExistence(timeout: 5), "通知上未出现「批准」按钮")
        approve.tap()

        // 等 act() 的 POST 落桩（/tmp/resolve.log 由 shell 侧断言）
        sleep(5)
    }
}
