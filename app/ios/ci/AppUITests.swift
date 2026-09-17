import XCTest

// iOS simulator spike：通知 action 全链验证。
// 被测应用由 CI 以 server.url=http://127.0.0.1:7480/?testNotify=1 构建：
// 页面加载后 3s 调度「审批 · CI-Test」本地通知（批准/拒绝两个 action），
// 本用例完成权限弹窗授权 → 退到桌面 → 通知中心点「批准」，
// 裁决 POST 是否到达桩服务器由 CI shell 侧断言（/tmp/resolve.log 含 ci-test-1）。
final class AppUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
        // 权限弹窗中断监听：弹窗一出现就点 Allow（在事件循环 idle 点自动触发，
        // 比手动等按钮稳——iOS 各版本弹窗宿主/层级有差异时的标准做法）
        addUIInterruptionMonitor(withDescription: "notification-permission") { alert in
            let allow = alert.buttons["Allow"]
            if allow.exists {
                allow.tap()
                return true
            }
            return false
        }
    }

    func testApprovalNotificationAction() throws {
        // 显式 bundle id 起宿主（TargetApplication 属性在手工注入的工程里不可靠，
        // 报 "No target application path specified"——用 bundle id 最稳）
        let app = XCUIApplication(bundleIdentifier: "run.anyplane")
        app.launch()

        // 主动交互让 interruption monitor 在 idle 点触发——必须避开屏幕中央：
        // 那里是系统弹窗的按钮区，居中 tap 曾误点「不允许」把权限永久拒绝（flaky 根因）
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let safeTap = app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.08))
        for _ in 0..<3 {
            safeTap.tap()
            sleep(1)
        }
        let allowBtn = springboard.alerts.firstMatch.buttons["Allow"]
        if allowBtn.waitForExistence(timeout: 20) {
            allowBtn.tap()
            sleep(1)
            if allowBtn.exists {
                allowBtn.tap() // 偶发首击不中，补一次
                sleep(1)
            }
        }
        if allowBtn.exists {
            XCTFail("权限弹窗无法消除。alerts=\(springboard.alerts.debugDescription.prefix(500)); buttons=\(springboard.buttons.debugDescription.prefix(500))")
            return
        }

        // 授权落地后立即压后台——钩子把通知延迟 15s 触发，后台送达才进通知中心
        XCUIDevice.shared.press(.home)
        sleep(2)
        let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.01))
        let bottom = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        top.press(forDuration: 0.05, thenDragTo: bottom)
        sleep(2)

        // 找到测试通知并长按展开操作
        let notification = springboard.staticTexts["审批 · CI-Test"]
        XCTAssertTrue(notification.waitForExistence(timeout: 40), "测试通知未出现在通知中心")
        notification.press(forDuration: 1.8)
        sleep(2)

        var approve = springboard.buttons["批准"]
        if !approve.exists {
            // 先留展开态证据，再做非破坏性的半程左滑（整滑会把通知直接清除）
            let dumpExpanded = springboard.buttons.debugDescription.prefix(700)
            let start = notification.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
            let end = notification.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.5))
            start.press(forDuration: 0.05, thenDragTo: end)
            sleep(1)
            let options = springboard.buttons["Options"]
            if options.waitForExistence(timeout: 3) {
                options.tap()
                sleep(1)
            }
            approve = springboard.buttons["批准"]
            if !approve.waitForExistence(timeout: 5) {
                let shortlook = springboard.descendants(matching: .any)
                    .matching(NSPredicate(format: "identifier CONTAINS 'ShortLook'"))
                    .debugDescription.prefix(1500)
                XCTFail("通知上未出现「批准」按钮。ShortLook 子树: \(shortlook)")
                return
            }
        }
        approve.tap()

        // 等 act() 的 POST 落桩（/tmp/resolve.log 由 shell 侧断言）
        sleep(5)
    }
}
