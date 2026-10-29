import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { Gallery } from "./lib/gallery.js";

const TYPES = new Set(["PoseGalleryImage", "PoseGalleryBatch"]);
const previews = new WeakMap();
const graphIds = new WeakMap();
let nextGraphId = 0;
const labels = { pose_id: "图片 ID", pose_ids: "图片 ID 清单", asset_source: "素材库", resize_mode: "尺寸处理", width: "宽度", height: "高度", flip_horizontal: "水平翻转", selection_mode: "选择方式", order: "排列顺序" };
const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = new URL("./gallery.css", import.meta.url).href;
document.head.append(stylesheet);

function widget(node, name) { return node.widgets?.find(value => value.name === name); }
function graphs() {
    return [...new Set([app.canvas?.graph, app.graph].filter(Boolean))];
}
function targets() {
    return graphs().flatMap(graph => {
        if (!graphIds.has(graph)) graphIds.set(graph, ++nextGraphId);
        return (graph._nodes || []).filter(node => TYPES.has(node.comfyClass || node.type)).map(node => ({
            id: graphIds.get(graph) + ":" + node.id, displayId: node.id, title: node.title, node, graph,
        }));
    });
}
function targetFor(node) { return targets().find(target => target.node === node)?.id || ""; }
function changed() { window.dispatchEvent(new Event("pose-gallery-nodes-changed")); }

const adapter = {
    async request(path, options = {}) {
        const init = { ...options };
        if (options.body) { init.body = JSON.stringify(options.body); init.headers = { ...options.headers, "Content-Type": "application/json" }; }
        const response = await api.fetchApi("/pose_gallery" + path, init);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "图库请求失败，请检查 ComfyUI 的运行状态。");
        return result;
    },
    image(source, id, thumbnail = false) {
        return api.apiURL("/pose_gallery/image?" + new URLSearchParams({ source, id, kind: thumbnail ? "thumb" : "original" }));
    },
    targets,
    apply({ ids, mode, source, targetId }) {
        const target = targetId ? targets().find(value => value.id === targetId) : null;
        if (targetId && !target) throw new Error("目标节点已移除，请重新选择接收节点。");
        let node = target?.node;
        const graph = target?.graph || app.canvas?.graph || app.graph;
        if (!graph) throw new Error("请先打开一个工作流。");
        if (node && (node.comfyClass || node.type) === "PoseGalleryImage" && ids.length > 1) {
            throw new Error("单图节点只能接收一张图片，请选择批量节点，或选择「新建图库节点」。");
        }
        const batch = node ? (node.comfyClass || node.type) === "PoseGalleryBatch" : mode === "batch";
        const values = { asset_source: source === "custom" ? "自定义素材库" : "内置素材库", pose_id: ids[0] };
        if (batch) Object.assign(values, { pose_ids: ids.join("\n"), selection_mode: "手动选择" });
        for (const name of Object.keys(values)) {
            if (node?.inputs?.some(input => input.name === name && input.link != null)) {
                throw new Error("目标节点的「" + (labels[name] || name) + "」由连线输入控制，请先断开该输入或新建图库节点。");
            }
        }
        graph.beforeChange?.();
        try {
            if (!node) {
                node = window.LiteGraph?.createNode(batch ? "PoseGalleryBatch" : "PoseGalleryImage");
                if (!node) throw new Error("图库节点尚未注册，请刷新 ComfyUI 页面后重试。");
                const canvas = app.canvas;
                const scale = canvas?.ds?.scale || 1;
                const offset = canvas?.ds?.offset || [0, 0];
                node.pos = [Math.max(0, (canvas?.canvas?.clientWidth || 900) / (2 * scale) - offset[0] - 170), Math.max(0, (canvas?.canvas?.clientHeight || 700) / (2 * scale) - offset[1] - 160)];
                graph.add(node);
            }
            for (const [name, value] of Object.entries(values)) {
                const input = widget(node, name);
                if (input) { input.value = value; input.callback?.(value); }
            }
            previews.get(node)?.();
            graph.setDirtyCanvas?.(true, true);
        } finally { graph.afterChange?.(); }
        changed();
        return node;
    },
    expand(state = {}) {
        const dialog = document.createElement("dialog");
        dialog.className = "pg-dialog pg-expanded";
        dialog.setAttribute("aria-label", "姿势图库选图器");
        const header = document.createElement("header"); header.className = "pg-dialog-header";
        const title = document.createElement("h2"); title.textContent = "姿势图库";
        const close = document.createElement("button"); close.type = "button"; close.className = "pg-button pg-quiet"; close.textContent = "返回工作流 ×";
        close.addEventListener("click", () => dialog.close()); header.append(title, close);
        const host = document.createElement("div"); host.className = "pg-expanded-host";
        dialog.append(header, host); document.body.append(dialog);
        const gallery = new Gallery(host, { ...adapter, expand() {} }, { ...state, expanded: true });
        dialog.addEventListener("close", () => { gallery.destroy(); dialog.remove(); }, { once: true });
        dialog.showModal();
        return gallery;
    },
};

app.registerExtension({
    name: "ComfyUI_Pose-Gallery_ZH.Gallery",
    setup() {
        let sidebar;
        if (app.extensionManager?.registerSidebarTab) {
            app.extensionManager.registerSidebarTab({
                id: "ComfyUI_Pose-Gallery_ZH", icon: "pi pi-images", title: "ComfyUI_Pose-Gallery_ZH", tooltip: "ComfyUI_Pose-Gallery_ZH · 中文姿势图库", type: "custom",
                render(host) {
                    Object.assign(host.style, { height: "100%", minHeight: "0", overflow: "hidden" });
                    if (sidebar?.host === host && host.querySelector(".pg-app")) return;
                    const state = sidebar ? { ...sidebar.state, selectedIds: [...sidebar.selected.keys()] } : {};
                    sidebar?.destroy();
                    sidebar = new Gallery(host, adapter, state);
                },
            });
        }
    },
    nodeCreated(node) {
        if (!TYPES.has(node.comfyClass || node.type)) return;
        for (const input of node.widgets || []) if (labels[input.name]) input.label = labels[input.name];
        const open = node.addWidget("button", "打开姿势图库", null, () => adapter.expand({
            source: widget(node, "asset_source")?.value === "自定义素材库" ? "custom" : "builtin", targetId: targetFor(node),
        }), { serialize: false });
        open.options = { ...open.options, serialize: false };
        const element = document.createElement("div"); element.className = "pg-node-preview";
        const image = document.createElement("img"); image.alt = "当前姿势预览";
        const caption = document.createElement("span"); element.append(image, caption);
        image.addEventListener("error", () => { image.hidden = true; caption.textContent += " · 图片缺失，请重新选图"; });
        const previewWidget = node.addDOMWidget("pose_gallery_preview", "image", element, { serialize: false, hideOnZoom: false });
        previewWidget.computeSize = () => [330, 180];
        previewWidget.options = { ...previewWidget.options, serialize: false, getMinHeight: () => 180, getMaxHeight: () => 180 };
        let timer;
        const refresh = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const source = widget(node, "asset_source")?.value === "自定义素材库" ? "custom" : "builtin";
                const manualBatch = (node.comfyClass || node.type) === "PoseGalleryBatch" && widget(node, "selection_mode")?.value === "手动选择";
                const ids = String(widget(node, manualBatch ? "pose_ids" : "pose_id")?.value || "").trim().split(/[\s,，;；]+/).filter(Boolean);
                const id = ids[0];
                image.hidden = !id;
                if (id) image.src = adapter.image(source, id, true);
                image.style.transform = widget(node, "flip_horizontal")?.value ? "scaleX(-1)" : "";
                caption.textContent = (id || "请打开图库选图") + (manualBatch ? " · 共 " + new Set(ids).size + " 张" : (node.comfyClass || node.type) === "PoseGalleryBatch" ? " · 全部已有角度" : "");
            }, 60);
        };
        previews.set(node, refresh);
        for (const input of node.widgets || []) {
            if (!labels[input.name]) continue;
            const previous = input.callback;
            input.callback = function (...args) { const result = previous?.apply(this, args); refresh(); return result; };
        }
        node.setSize([Math.max(node.size[0], 340), Math.max(node.size[1], node.computeSize()[1])]);
        refresh(); queueMicrotask(changed);
    },
    afterConfigureGraph() {
        for (const { node } of targets()) previews.get(node)?.();
        changed();
    },
});
