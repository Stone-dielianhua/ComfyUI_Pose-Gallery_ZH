# ComfyUI_Pose-Gallery_ZH · 验证记录与复现

2026-10-28，本地独立实例使用 ComfyUI 0.43.0、前端 1.57.6、Python 3.12、PyTorch 2.10.0、Edge / Playwright 1.62.1。

已完成：

- 以独立目录 `ComfyUI_Pose-Gallery_ZH` 加载插件并完成浏览器联调，素材不依赖外层原项目。
- 15 项后端检查：分组、缺失视角、素材存在性、IMAGE 张量范围和尺寸、批次顺序、翻转和留边、配置保存、失效目录、文件变化、HTTP 接口与越界路径。
- 4 项前端逻辑检查：复合搜索、分组、视角顺序、收藏与最近使用、浏览器存储不可用时降级。
- 2,878 个文件的存在、大小、PNG/JPG 文件头校验，无异常。
- 真实浏览器联调：侧栏和展开选图、双列布局、指定节点更新、保留连线和尺寸、单图拒收多图、批量发送、缺失角度禁用、保存并重新打开工作流、自定义目录切换。
- 提交真实执行任务，输出 1 张 128×160 单图和 5 张 64×80 批量图片，读取输出 PNG 验证尺寸。
- 单图示例、全部角度批量示例分别在真实 ComfyUI 中运行，输出 1 张和 5 张图片。

DWPose 和 ControlNet 示例用已安装扩展的节点接口核对接线，未执行骨架推理或扩散采样。其他软件版本仍需实际验证。

## 自动检查

使用 ComfyUI 的 Python：

```bash
python -m unittest discover -s tests -v
python -X utf8 scripts/verify.py
```

使用 Node.js 22 或以上：

```bash
node --test tests/frontend.test.mjs
```

## 浏览器联调

测试清空当前工作流、执行图片预览、暂时设置并清空自定义目录。请使用专门的测试实例和用户目录。

```bash
npm install
npx playwright install chromium
```

启动仅加载本插件的独立 ComfyUI，示例端口 8197，再运行：

```powershell
# Windows PowerShell
$env:POSE_GALLERY_TEST_URL = "http://127.0.0.1:8197"
npm run test:browser
```

```bash
# Linux / macOS
POSE_GALLERY_TEST_URL=http://127.0.0.1:8197 npm run test:browser
```

可选设置 `POSE_GALLERY_BROWSER_CHANNEL=msedge`，使用已安装的 Edge。测试产物放入忽略提交的 `.test-output/`，截图更新 `docs/plugin-preview.png`。
