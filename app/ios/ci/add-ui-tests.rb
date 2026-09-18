# iOS simulator spike：向 Capacitor 生成的 App.xcodeproj 注入 UI 测试目标。
# 不手改 pbxproj 入库——CI 每次现生成（xcodeproj gem，macos runner 上 gem install）。
# 用法：ruby app/ios/ci/add-ui-tests.rb
require 'xcodeproj'
require 'fileutils'

# 注意：本脚本在 working-directory=app 下执行，路径以 app/ 为根
PROJ_PATH = 'ios/App/App.xcodeproj'
SCHEME_DIR = 'ios/App/App.xcodeproj/xcshareddata/xcschemes'
SCHEME_PATH = "#{SCHEME_DIR}/App.xcscheme"
TEST_SRC = 'ios/ci/AppUITests.swift'

proj = Xcodeproj::Project.open(PROJ_PATH)
app_target = proj.targets.find { |t| t.name == 'App' }
abort('App target 不存在') unless app_target

# 幂等：已有目标先删掉重建（CI 每次重跑脚本）
existing = proj.targets.find { |t| t.name == 'AppUITests' }
proj.remove_target(existing) if existing.respond_to?(:remove_target) && existing

test_target = proj.new_target(:ui_test_bundle, 'AppUITests', :ios, '15.0')
test_target.product_type = 'com.apple.product-type.bundle.ui-testing'

group = proj.main_group.find_subpath('App', true)
file_ref = group.new_file(File.expand_path(TEST_SRC))
file_ref.name = 'AppUITests.swift'
test_target.add_file_references([file_ref])

# Xcode 14+ 默认 XCTRunner：不设 TEST_HOST/BUNDLE_LOADER（两者与 XCTRunner 互斥，
# 错误 "sets both USES_XCTRUNNER and either TEST_HOST or RUNTIME_TEST_HOST"），
# 宿主应用经 TargetApplication 属性关联
test_target.add_dependency(app_target)
attrs = proj.root_object.attributes['TargetAttributes'] ||= {}
attrs[test_target.uuid] = { 'TargetApplication' => app_target.uuid }

test_target.build_configurations.each do |config|
  config.build_settings['PRODUCT_NAME'] = 'AppUITests'
  config.build_settings['SWIFT_VERSION'] = '5.0'
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'run.anyplane.uitests'
  config.build_settings['GENERATE_INFOPLIST_FILE'] = 'YES'
  config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
  config.build_settings['TARGETED_DEVICE_FAMILY'] = '1,2'
end
proj.save

# 裸应用判别器目标（零 Capacitor 的同款通知：区分平台回归 vs 插件问题）
bare_existing = proj.targets.find { |t| t.name == 'BareApp' }
proj.remove_target(bare_existing) if bare_existing.respond_to?(:remove_target) && bare_existing
bare_target = proj.new_target(:application, 'BareApp', :ios, '15.0')
bare_target.product_type = 'com.apple.product-type.application'
bare_ref = group.new_file(File.expand_path('ios/ci/BareAppDelegate.swift'))
bare_ref.name = 'BareAppDelegate.swift'
bare_target.add_file_references([bare_ref])
bare_target.build_configurations.each do |config|
  config.build_settings['PRODUCT_NAME'] = 'BareApp'
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'run.anyplane.bare'
  config.build_settings['SWIFT_VERSION'] = '5.0'
  config.build_settings['GENERATE_INFOPLIST_FILE'] = 'YES'
  config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
  config.build_settings['TARGETED_DEVICE_FAMILY'] = '1,2'
  # 纯代码 UIWindow：不要 scene manifest / storyboard
  config.build_settings['INFOPLIST_KEY_UILaunchStoryboardName'] = ''
end
proj.save

# scheme 落 shared 路径，xcodebuild -scheme App 才能找到
FileUtils.mkdir_p(SCHEME_DIR)
scheme = File.exist?(SCHEME_PATH) ? Xcodeproj::XCScheme.new(SCHEME_PATH) : Xcodeproj::XCScheme.new
scheme.add_build_target(app_target)
scheme.add_build_target(bare_target)
scheme.add_test_target(test_target)
scheme.set_launch_target(app_target)
scheme.save_as(PROJ_PATH, 'App', true)
puts 'AppUITests 与 BareApp 目标及 scheme 注入完成'
