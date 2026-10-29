import { ANGLES, MAX_BATCH, buildGroups, filterItems, groupKey, listEntries, readLocal, writeLocal } from "./store.js";

function el(tag, cls = "", text = "") {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
}
function button(text, action, cls = "") {
    const node = el("button", `pg-button ${cls}`, text);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
}
function options(select, values, allLabel) {
    select.replaceChildren();
    if (allLabel) select.add(new Option(allLabel, ""));
    for (const value of values) select.add(new Option(value, value));
}
function field(label, input) {
    const node = el("label", "pg-field");
    node.append(el("span", "pg-label", label), input);
    return node;
}
function imageNode(url, alt, cls = "") {
    const image = el("img", cls);
    image.src = url;
    image.alt = alt;
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => {
        image.classList.add("pg-image-missing");
        image.alt = "图片缺失，请检查素材目录";
    });
    return image;
}
function dialogShell(title, cls = "") {
    const dialog = el("dialog", `pg-dialog ${cls}`);
    dialog.setAttribute("aria-label", title);
    const header = el("header", "pg-dialog-header");
    header.append(el("h2", "", title), button("关闭 ×", () => dialog.close(), "pg-quiet"));
    dialog.append(header);
    dialog.addEventListener("click", event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog);
    return dialog;
}

export class Gallery {
    constructor(container, adapter, initial = {}) {
        const { source = "builtin", targetId = "", expanded = false } = initial;
        this.host = container;
        this.adapter = adapter;
        this.state = { query: "", system: "", category: "", angle: "", collection: "all", grouped: true, shown: 48, ...initial, source, targetId: String(targetId) };
        this.expanded = expanded;
        this.items = [];
        this.groups = new Map();
        this.byId = new Map();
        this.selected = new Map();
        this.previewByGroup = new Map();
        this.ownedDialogs = new Set();
        this.abort = new AbortController();
        this.loadSerial = 0;
        this.build();
        this.load();
    }

    build() {
        this.root = el("section", "pg-app");
        this.root.setAttribute("aria-label", "ComfyUI_Pose-Gallery_ZH · 中文姿势图库");
        const header = el("header", "pg-header");
        const brand = el("div", "pg-brand");
        const title = el("div");
        title.append(el("div", "pg-eyebrow", "ComfyUI_Pose-Gallery_ZH"), el("h2", "pg-title", "找一个好姿势"));
        this.stats = el("p", "pg-muted", "正在读取本地素材…");
        title.append(this.stats);
        brand.append(el("span", "pg-brand-symbol", "姿"), title);
        const actions = el("div", "pg-header-actions");
        actions.append(button("素材设置", () => this.settings(), "pg-quiet"));
        if (!this.expanded) actions.append(button("展开 ↗", () => {
            const picker = this.adapter.expand({ ...this.state, selectedIds: [...this.selected.keys()] });
            picker?.root.closest("dialog")?.addEventListener("close", () => {
                if (this.state.source === picker.state.source) {
                    this.selected = new Map(picker.selected); this.render(false);
                }
            }, { once: true });
        }, "pg-quiet"));
        header.append(brand, actions);
        const controls = el("div", "pg-controls");
        this.sourceSelect = el("select");
        this.sourceSelect.add(new Option("插件内附素材", "builtin"));
        this.sourceSelect.add(new Option("自定义素材目录", "custom"));
        this.sourceSelect.value = this.state.source;
        this.sourceSelect.addEventListener("change", () => this.changeSource(this.sourceSelect.value));
        this.search = el("input", "pg-search");
        this.search.type = "search";
        this.search.placeholder = "搜索姿势、编号、分类…";
        this.search.setAttribute("aria-label", "搜索姿势");
        this.search.value = this.state.query;
        this.search.addEventListener("input", () => { this.state.query = this.search.value; this.render(); });
        controls.append(field("素材库", this.sourceSelect), this.search);
        const filters = el("div", "pg-filters");
        for (const [name, label] of [["system", "体系"], ["category", "动作分类"], ["angle", "视角"]]) {
            const select = el("select");
            this[`${name}Select`] = select;
            options(select, [], `全部${label}`);
            select.addEventListener("change", () => {
                this.state[name] = select.value;
                if (name === "system") { this.state.category = ""; this.updateCategories(); }
                this.render();
            });
            filters.append(field(label, select));
        }
        options(this.angleSelect, ANGLES, "全部视角");
        this.angleSelect.value = this.state.angle;
        this.groupSelect = el("select");
        this.groupSelect.add(new Option("按姿势分组", "group"));
        this.groupSelect.add(new Option("逐张浏览", "single"));
        this.groupSelect.value = this.state.grouped ? "group" : "single";
        this.groupSelect.addEventListener("change", () => { this.state.grouped = this.groupSelect.value === "group"; this.render(); });
        filters.append(field("浏览方式", this.groupSelect));
        controls.append(filters);
        const collection = el("div", "pg-collections");
        this.collectionButtons = [];
        for (const [key, label] of [["all", "全部姿势"], ["favorites", "♡ 收藏"], ["recent", "最近使用"]]) {
            const tab = button(label, () => { this.state.collection = key; this.render(); }, "pg-tab");
            tab.dataset.collection = key;
            this.collectionButtons.push(tab);
            collection.append(tab);
        }
        collection.append(button("重置筛选", () => this.resetFilters(), "pg-reset pg-quiet"));
        this.summary = el("div", "pg-summary");
        this.message = el("div", "pg-message");
        this.message.setAttribute("role", "status");
        this.message.setAttribute("aria-live", "polite");
        this.scroller = el("div", "pg-scroll");
        this.grid = el("div", "pg-grid");
        this.more = button("加载更多", () => { this.state.shown += 48; this.render(false); }, "pg-more");
        this.scroller.append(this.grid, this.more);
        const targetRow = el("div", "pg-target-row");
        this.target = el("select");
        this.target.setAttribute("aria-label", "接收姿势的图库节点");
        this.target.addEventListener("change", () => { this.state.targetId = this.target.value; });
        this.target.addEventListener("focus", () => this.refreshTargets());
        targetRow.append(field("发送到", this.target));
        this.selectionLabel = el("strong", "pg-selection-label", "已选 0 张");
        const selectionActions = el("div", "pg-selection-actions");
        this.reviewButton = button("查看已选", () => this.reviewSelection(), "pg-quiet");
        this.clearButton = button("清空", () => { this.selected.clear(); this.render(false); }, "pg-quiet");
        this.sendButton = button("发送所选图片", () => this.send([...this.selected.keys()], "batch"), "pg-primary");
        selectionActions.append(this.reviewButton, this.clearButton, this.sendButton);
        const bottom = el("footer", "pg-bottom");
        const selectedRow = el("div", "pg-selection-row");
        selectedRow.append(this.selectionLabel, selectionActions);
        bottom.append(targetRow, selectedRow);
        const credit = el("div", "pg-credit", "图片：ギア · 中文数据：Anhao");
        credit.append(button("使用说明", () => this.help(), "pg-link"));
        bottom.append(credit);
        this.root.append(header, controls, collection, this.summary, this.message, this.scroller, bottom);
        this.host.replaceChildren(this.root);
        this.root.addEventListener("keydown", event => {
            if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) {
                event.preventDefault(); event.stopPropagation(); this.search.focus();
            }
        }, { signal: this.abort.signal });
        window.addEventListener("pose-gallery-nodes-changed", () => this.refreshTargets(), { signal: this.abort.signal });
        window.addEventListener("pose-gallery-storage-changed", () => this.render(false), { signal: this.abort.signal });
        window.addEventListener("pose-gallery-directory-changed", () => {
            if (this.state.source !== "custom") return;
            for (const dialog of this.ownedDialogs) if (!dialog.classList.contains("pg-settings")) dialog.close();
            this.selected.clear(); this.updateSelection(); this.load();
        }, { signal: this.abort.signal });
        this.refreshTargets();
        this.updateSelection();
    }

    async load() {
        const serial = ++this.loadSerial;
        this.notice("正在读取本地素材…");
        this.grid.replaceChildren();
        this.more.hidden = true;
        try {
            const result = await this.adapter.request(`/catalogue?source=${this.state.source}`);
            if (serial !== this.loadSerial || this.abort.signal.aborted) return;
            this.items = result.items;
            this.byId = new Map(this.items.map(item => [item.id, item]));
            this.groups = buildGroups(this.items);
            if (this.state.selectedIds) {
                this.selected = new Map(this.state.selectedIds.filter(id => this.byId.has(id)).map(id => [id, this.byId.get(id)]));
                delete this.state.selectedIds;
            }
            this.stats.textContent = `${result.groups} 组姿势 · ${result.count} 张参考图 · 本地离线`;
            options(this.systemSelect, [...new Set(this.items.map(item => item.体系))], "全部体系");
            this.systemSelect.value = this.state.system;
            this.updateCategories();
            this.notice("");
            this.render();
        } catch (error) {
            if (serial !== this.loadSerial || this.abort.signal.aborted) return;
            this.items = []; this.byId.clear(); this.groups.clear();
            this.stats.textContent = "素材库尚未就绪";
            this.summary.textContent = "";
            this.notice(error.message, true);
            this.grid.append(el("div", "pg-empty", "可以在「素材设置」中配置目录，或切换回插件内附素材。"));
        }
    }

    changeSource(source) {
        this.state.source = source;
        this.sourceSelect.value = source;
        this.selected.clear(); this.previewByGroup.clear();
        this.resetFilters(false); this.updateSelection(); this.load();
    }

    resetFilters(render = true) {
        Object.assign(this.state, { query: "", system: "", category: "", angle: "", collection: "all" });
        this.search.value = this.systemSelect.value = this.categorySelect.value = this.angleSelect.value = "";
        this.updateCategories();
        if (render) this.render();
    }

    updateCategories() {
        options(this.categorySelect, [...new Set(this.items.filter(item => !this.state.system || item.体系 === this.state.system).map(item => item.分类))], "全部分类");
        this.categorySelect.value = this.state.category;
    }

    favorites() { return readLocal(`favorites.${this.state.source}`, []); }
    recent() { return readLocal(`recent.${this.state.source}`, []); }
    isFavorite(id) { return this.favorites().includes(id); }
    toggleFavorite(id) {
        const list = this.favorites();
        writeLocal(`favorites.${this.state.source}`, list.includes(id) ? list.filter(value => value !== id) : [...list, id]);
        window.dispatchEvent(new Event("pose-gallery-storage-changed"));
    }

    render(reset = true) {
        if (reset) { this.state.shown = 48; this.scroller.scrollTop = 0; }
        const matching = filterItems(this.items, this.state, this.favorites(), this.recent());
        this.entries = listEntries(matching, this.state.grouped);
        this.summary.textContent = this.state.grouped ? `${this.entries.length} 组姿势 · ${matching.length} 张图片` : `${matching.length} 张图片`;
        for (const tab of this.collectionButtons) tab.setAttribute("aria-pressed", String(tab.dataset.collection === this.state.collection));
        this.grid.replaceChildren();
        if (!this.entries.length) this.grid.append(el("div", "pg-empty", this.state.collection === "favorites" ? "还没有匹配的收藏。点击图片上的 ♡ 收藏这个视角。" : this.state.collection === "recent" ? "最近使用的姿势会显示在这里。" : "没有找到符合条件的姿势，试试减少筛选条件。"));
        for (const entry of this.entries.slice(0, this.state.shown)) this.grid.append(this.card(entry));
        this.more.hidden = this.entries.length <= this.state.shown;
        if (!this.more.hidden) this.more.textContent = `加载更多 · 还有 ${this.entries.length - this.state.shown} 项`;
        this.updateSelection();
    }

    card(entry) {
        let item = this.byId.get(this.previewByGroup.get(entry.key)) || entry.item;
        if (!entry.matches.some(match => match.id === item.id)) item = entry.item;
        const card = el("article", "pg-card");
        const media = el("div", "pg-card-media");
        const open = button("", () => this.view(item), "pg-image-button");
        open.setAttribute("aria-label", `预览 ${item.姿势名称} · ${item.角度}`);
        open.append(imageNode(this.adapter.image(this.state.source, item.id, true), `${item.姿势名称} ${item.角度}`));
        const badges = el("div", "pg-badges");
        badges.append(el("span", "pg-badge", item.姿势编号), el("span", "pg-badge pg-angle-badge", item.角度));
        const favorite = button(this.isFavorite(item.id) ? "♥" : "♡", () => this.toggleFavorite(item.id), "pg-favorite");
        favorite.setAttribute("aria-label", `收藏 ${item.姿势名称} ${item.角度}`);
        favorite.setAttribute("aria-pressed", String(this.isFavorite(item.id)));
        const checkbox = el("input");
        checkbox.type = "checkbox"; checkbox.checked = this.selected.has(item.id);
        checkbox.setAttribute("aria-label", `选择 ${item.姿势名称} ${item.角度}`);
        checkbox.addEventListener("change", () => { this.toggleSelection(item); this.render(false); });
        const checkLabel = el("label", "pg-check");
        checkLabel.append(checkbox, el("span", "", "选择"));
        media.append(open, badges, favorite, checkLabel);
        const body = el("div", "pg-card-body");
        body.append(button(item.姿势名称, () => this.view(item), "pg-card-title"), el("p", "pg-card-meta", `${item.体系} · ${item.分类}`));
        card.append(media, body);
        if (this.state.grouped) {
            const strip = el("div", "pg-angle-strip");
            const group = this.groups.get(groupKey(item));
            for (const angle of ANGLES) {
                const candidate = group.items.find(value => value.角度 === angle);
                const angleButton = button(angle, () => {
                    this.previewByGroup.set(entry.key, candidate.id);
                    // A preview outside the current filter opens separately, preserving the grid's meaning.
                    if (!entry.matches.some(match => match.id === candidate.id)) this.view(candidate);
                    else this.render(false);
                }, candidate?.id === item.id ? "pg-angle pg-active" : "pg-angle");
                angleButton.disabled = !candidate;
                angleButton.title = candidate ? `${angle} · 点击切换，打开大图可选取所有角度` : `${angle} 暂无素材`;
                strip.append(angleButton);
            }
            card.append(strip);
        }
        return card;
    }

    toggleSelection(item) {
        if (this.selected.has(item.id)) this.selected.delete(item.id);
        else if (this.selected.size >= MAX_BATCH) this.notice(`单批最多 ${MAX_BATCH} 张。`, true);
        else { this.selected.set(item.id, item); this.notice(""); }
        this.updateSelection();
    }

    updateSelection() {
        this.selectionLabel.textContent = `已选 ${this.selected.size} / ${MAX_BATCH} 张`;
        this.sendButton.disabled = this.reviewButton.disabled = this.clearButton.disabled = !this.selected.size;
    }

    refreshTargets() {
        const current = this.state.targetId;
        this.target.replaceChildren(new Option("新建图库节点", ""));
        for (const node of this.adapter.targets()) this.target.add(new Option(`#${node.displayId ?? node.id} ${node.title}`, String(node.id)));
        this.target.value = [...this.target.options].some(option => option.value === current) ? current : "";
        this.state.targetId = this.target.value;
    }

    async send(ids, mode, dialog = null) {
        if (!ids.length) return;
        try {
            this.adapter.apply({ ids, mode, source: this.state.source, targetId: this.state.targetId });
            const old = this.recent();
            writeLocal(`recent.${this.state.source}`, [...ids, ...old.filter(id => !ids.includes(id))].slice(0, 80));
            this.notice(`已发送 ${ids.length} 张图片到图库节点。`);
            dialog?.close();
            window.dispatchEvent(new Event("pose-gallery-storage-changed"));
        } catch (error) { this.notice(error.message, true); if (dialog) this.dialogNotice(dialog, error.message); }
    }

    notice(message, error = false) {
        this.message.textContent = message; this.message.hidden = !message;
        this.message.classList.toggle("pg-error", error);
    }

    own(dialog) {
        this.ownedDialogs.add(dialog);
        dialog.addEventListener("close", () => this.ownedDialogs.delete(dialog), { once: true });
        return dialog;
    }

    dialogNotice(dialog, message) {
        let notice = dialog.querySelector(".pg-dialog-notice");
        if (!notice) { notice = el("p", "pg-dialog-notice pg-error"); dialog.append(notice); }
        notice.textContent = message;
    }

    view(initial) {
        let current = initial;
        const source = this.state.source;
        const dialog = this.own(dialogShell("姿势预览", "pg-viewer"));
        const content = el("div", "pg-viewer-content");
        const stage = el("div", "pg-stage");
        const image = imageNode(this.adapter.image(source, current.id), current.姿势名称);
        image.loading = "eager";
        stage.append(image);
        const details = el("div", "pg-details");
        const number = el("div", "pg-eyebrow");
        const title = el("h3", "pg-viewer-title");
        const meta = el("p", "pg-muted");
        const id = el("code", "pg-id");
        const angles = el("div", "pg-viewer-angles");
        const nav = el("div", "pg-viewer-nav");
        nav.append(button("↑ 上个姿势", () => stepPose(-1)), button("下个姿势 ↓", () => stepPose(1)));
        const choose = button("选择此角度", () => { this.toggleSelection(current); update(); this.render(false); });
        const allAngles = button("选择该姿势全部已有角度", () => {
            const group = this.groups.get(groupKey(current));
            const extra = group.items.filter(item => !this.selected.has(item.id));
            if (this.selected.size + extra.length > MAX_BATCH) { this.dialogNotice(dialog, `单批最多 ${MAX_BATCH} 张，请先清理部分选择。`); return; }
            for (const item of group.items) this.selected.set(item.id, item);
            this.updateSelection(); update(); this.render(false);
        });
        const use = button("使用此姿势", () => this.send([current.id], "single", dialog), "pg-primary");
        const download = el("a", "pg-button pg-download", "下载原图");
        download.download = `${current.id}.png`;
        const copy = button("复制图片 ID", async () => {
            try { await navigator.clipboard.writeText(current.id); copy.textContent = "已复制"; }
            catch { this.dialogNotice(dialog, `图片 ID：${current.id}`); }
        }, "pg-quiet");
        const hint = el("p", "pg-hint", "← → 切换角度 · ↑ ↓ 切换姿势 · Esc 关闭");
        details.append(number, title, meta, id, angles, nav, choose, allAngles, use, download, copy, hint);
        content.append(stage, details); dialog.append(content);
        const update = () => {
            number.textContent = current.姿势编号; title.textContent = current.姿势名称;
            meta.textContent = `${current.体系} · ${current.分类} · ${current.角度}`; id.textContent = current.id;
            image.classList.remove("pg-image-missing"); image.src = this.adapter.image(source, current.id); image.alt = `${current.姿势名称} ${current.角度}`;
            download.href = this.adapter.image(source, current.id); download.download = current.id + "." + current.原图.split(".").pop();
            choose.textContent = this.selected.has(current.id) ? "✓ 已选择此角度 · 点击取消" : "选择此角度";
            copy.textContent = "复制图片 ID";
            angles.replaceChildren();
            const group = this.groups.get(groupKey(current));
            for (const angle of ANGLES) {
                const item = group.items.find(value => value.角度 === angle);
                const tab = button(angle, () => { current = item; update(); }, item?.id === current.id ? "pg-active" : "");
                tab.disabled = !item; angles.append(tab);
            }
        };
        const stepAngle = step => {
            const list = this.groups.get(groupKey(current)).items;
            current = list[(list.indexOf(current) + step + list.length) % list.length]; update();
        };
        const stepPose = step => {
            const visibleGroups = [...new Set(this.entries.map(entry => groupKey(entry.item)))];
            const position = visibleGroups.indexOf(groupKey(current));
            const next = visibleGroups[position + step];
            if (!next) return;
            const list = this.groups.get(next).items;
            current = list.find(item => item.角度 === current.角度) || list[0]; update();
        };
        dialog.addEventListener("keydown", event => {
            if (["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) return;
            const action = { ArrowLeft: () => stepAngle(-1), ArrowRight: () => stepAngle(1), ArrowUp: () => stepPose(-1), ArrowDown: () => stepPose(1) }[event.key];
            if (action) { event.preventDefault(); event.stopPropagation(); action(); }
        });
        let startX = null;
        stage.addEventListener("touchstart", event => { if (event.touches.length === 1) startX = event.touches[0].clientX; }, { passive: true });
        stage.addEventListener("touchend", event => {
            if (startX !== null && Math.abs(event.changedTouches[0].clientX - startX) > 60) stepAngle(event.changedTouches[0].clientX < startX ? 1 : -1);
            startX = null;
        }, { passive: true });
        update(); dialog.showModal();
    }

    reviewSelection() {
        const dialog = this.own(dialogShell("已选图片 · 按选择顺序输出", "pg-review"));
        const list = el("div", "pg-review-list");
        const update = () => {
            list.replaceChildren();
            for (const [id, item] of this.selected) {
                const row = el("div", "pg-review-row");
                const text = el("div"); text.append(el("strong", "", item.姿势名称), el("p", "pg-muted", `${item.角度} · ${id}`));
                row.append(imageNode(this.adapter.image(this.state.source, id, true), item.姿势名称), text, button("移除", () => { this.selected.delete(id); update(); this.render(false); }));
                list.append(row);
            }
            if (!this.selected.size) list.append(el("p", "pg-muted", "已清空选择。"));
        };
        dialog.append(list, button("发送所选图片", () => this.send([...this.selected.keys()], "batch", dialog), "pg-primary pg-dialog-action"));
        update(); dialog.showModal();
    }

    async settings() {
        const dialog = this.own(dialogShell("素材设置", "pg-settings"));
        const content = el("div", "pg-settings-content");
        content.append(el("h3", "", "插件内附，安装即可使用"), el("p", "pg-muted", "默认读取插件中的 data、img、thumbs。图库与图片节点无需联网，也无需额外模型。"));
        const input = el("input"); input.type = "text"; input.placeholder = "留空即可使用内附素材"; input.autocomplete = "off";
        input.disabled = true;
        content.append(field("自定义素材目录（可选）", input), el("p", "pg-muted", "填写 ComfyUI 所在电脑上的绝对路径；远程使用时不是浏览器所在电脑的路径。目录须有 data/pose-zh.json 和清单引用的图片。"));
        const status = el("p", "pg-settings-status"); status.setAttribute("role", "status");
        const save = button("检查并保存", async () => {
            save.disabled = true; status.textContent = "正在检查素材目录…";
            try {
                const result = await this.adapter.request("/settings", { method: "POST", body: { custom_directory: input.value } });
                input.value = result.custom_directory; status.textContent = "已保存。可在图库顶部切换素材库。"; status.classList.remove("pg-error");
                if (this.state.source === "custom" && !result.custom_directory) this.changeSource("builtin");
                window.dispatchEvent(new Event("pose-gallery-directory-changed"));
            } catch (error) { status.textContent = error.message; status.classList.add("pg-error"); }
            finally { save.disabled = false; }
        }, "pg-primary");
        save.disabled = true;
        content.append(status, save, button("清空目录输入", () => { input.value = ""; status.textContent = "点击保存后生效。"; }, "pg-quiet"), el("p", "pg-hint", "目录设置在本机的 ComfyUI 用户目录中保存。节点分别记住内置／自定义素材库和图片 ID，切换浏览库不会改写已有节点。"));
        dialog.append(content); dialog.showModal();
        try {
            const result = await this.adapter.request("/settings");
            if (!dialog.isConnected) return;
            input.value = result.custom_directory; input.disabled = save.disabled = false;
        } catch (error) { status.textContent = error.message; status.classList.add("pg-error"); }
    }

    help() {
        const dialog = this.own(dialogShell("使用说明与素材来源", "pg-settings"));
        const content = el("div", "pg-settings-content");
        for (const [title, text] of [
            ["单张使用", "搜索并打开姿势，确认视角后点击「使用此姿势」。默认新建单图节点，也可先在底部指定已有图库节点。"],
            ["批量使用", "勾选图片后点击「发送所选图片」。选择顺序会保存到批量节点，也可改为输出某个姿势的全部已有角度。"],
            ["控制生成姿势", "本图库输出人物参考图。先接 DWPose／OpenPose 预处理，再接匹配的姿势 ControlNet；图库本身不提取骨架。"],
            ["收藏与工作流", "收藏和最近使用保存在当前浏览器。姿势 ID、素材库和尺寸参数随工作流保存；分享后接收者也需要安装插件和对应素材。"],
            ["素材来源", "图片与原始数据：ギア（giaaibusi）。中文数据与原画廊代码：Anhao。素材含成人向艺术姿势参考；图片和原始数据不适用代码的 MIT 协议，使用范围见仓库 LICENSE。"],
        ]) content.append(el("h3", "", title), el("p", "pg-muted", text));
        const link = el("a", "pg-source-link", "原项目与授权说明 ↗");
        link.href = "https://github.com/anhao/ai-pose-gallery-zh"; link.target = "_blank"; link.rel = "noopener noreferrer";
        content.append(link); dialog.append(content); dialog.showModal();
    }

    destroy() {
        this.abort.abort(); this.loadSerial++;
        for (const dialog of this.ownedDialogs) dialog.close();
        this.host.replaceChildren();
    }
}
