import XCTest

// iOS simulator spike：通知 action 全链验证 + 裸应用判别器。
// testApprovalNotificationAction：被测应用由 CI 以 server.url 注入构建，
//   页面钩子调度「审批 · CI-Test」本地通知（批准/拒绝），验证
//   权限 → registerActionTypes → 调度 → ShortLook 按钮 → action 回传 → POST 落桩。
// testBareDiscriminator：零 Capacitor 裸应用注册同款 category/通知——
//   若同样渲染不出按钮 → iOS 26 平台回归实锤；若能渲染 → 问题在 Capacitor 插件。
final class AppUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
        // 权限弹窗中断监听：弹窗一出现就点 Allow（事件循环 idle 点自动触发）
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
        try driveNotificationActionTest(bundleId: "run.anyplane", expectResolvePost: true)
    }

    func testBareDiscriminator() throws {
        try driveNotificationActionTest(bundleId: "run.anyplane.bare", expectResolvePost: false)
    }

    private func driveNotificationActionTest(bundleId: String, expectResolvePost: Bool) throws {
        // 显式 bundle id 起宿主（TargetApplication 属性在手工注入的工程里不可靠）
        let app = XCUIApplication(bundleIdentifier: bundleId)
        app.launch()

        // 主动交互让 interruption monitor 在 idle 点触发——避开屏幕中央（系统弹窗按钮区）
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
                allowBtn.tap()
                sleep(1)
            }
        }
        if allowBtn.exists {
            XCTFail("权限弹窗无法消除。alerts=\(springboard.alerts.debugDescription.prefix(500))")
            return
        }

        // 授权落地后立即压后台——通知延迟触发，后台送达才进通知中心
        XCUIDevice.shared.press(.home)
        sleep(2)

        // 拉出通知中心
        let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.01))
        let bottom = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        top.press(forDuration: 0.05, thenDragTo: bottom)
        sleep(2)

        // 找到测试通知：先下拉展开，再长按兜底
        let notification = springboard.staticTexts["审批 · CI-Test"]
        XCTAssertTrue(notification.waitForExistence(timeout: 40), "[\(bundleId)] 测试通知未出现在通知中心")
        let nCenter = notification.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let nBelow = notification.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 2.5))
        nCenter.press(forDuration: 0.05, thenDragTo: nBelow)
        sleep(2)

        var approve = springboard.buttons["批准"]
        if !approve.exists {
            notification.press(forDuration: 1.8)
            sleep(2)
            approve = springboard.buttons["批准"]
        }
        // 不论成败都留现场照（CI 侧导出为 PNG 工件，眼见为实）
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "shortlook-\(bundleId)"
        shot.lifetime = .keepAlways
        add(shot)
        if !approve.exists {
            let shortlook = springboard.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier CONTAINS 'ShortLook'"))
                .debugDescription.prefix(1500)
            XCTFail("[\(bundleId)] 通知上未出现「批准」按钮。ShortLook 子树: \(shortlook)")
            return
        }
        approve.tap()

        if expectResolvePost {
            // 等 act() 的 POST 落桩（/tmp/resolve.log 由 shell 侧断言）
            sleep(5)
        }
    }
}
