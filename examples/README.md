# ComfyUI_Pose-Gallery_ZH · 示例工作流

将 JSON 拖入 ComfyUI。

1. `01_single_image.json`：默认内附图片 → 预览，无额外模型。
2. `02_batch_all_angles.json`：当前姿势全部已有角度 → 批量预览，等比留边 768×1024。
3. `03_dwpose_preview.json`：图库 → DWPose → 骨架预览。需要 `comfyui_controlnet_aux` 及其预处理模型。
4. `04_controlnet_template.json`：完整 SD1.5 姿势控制接线。先替换加载器中的模型占位名称，选择本机 SD1.5 基础模型与匹配的 OpenPose ControlNet。画面 512×768，可自行调整。

前两个示例已在真实 ComfyUI 上运行。后两个已核对节点接口与连接，未执行推理或采样。
