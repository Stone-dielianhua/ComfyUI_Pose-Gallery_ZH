import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ANGLES, buildGroups, filterItems, groupKey, listEntries, readLocal, writeLocal } from '../js/lib/store.js';

const items = JSON.parse(await readFile(new URL('../data/pose-zh.json', import.meta.url), 'utf8'));
const state = { query:'', system:'', category:'', angle:'', collection:'all' };

test('groups include system identity and preserve all existing angles', () => {
    const groups = buildGroups(items);
    assert.equal(groups.size,288);
    assert.equal([...groups.values()].filter(group=>group.items.length===4).length,1);
    const sameNumber = items.filter(item=>item.姿势编号==='P001');
    assert.equal(new Set(sameNumber.map(groupKey)).size,4);
    for (const group of groups.values()) {
        const ranks = group.items.map(item=>ANGLES.indexOf(item.角度));
        assert.deepEqual(ranks,[...ranks].sort((a,b)=>a-b));
    }
});
test('combined Chinese search and filters match every criterion', () => {
    const results=filterItems(items,{...state,query:'P001 坐姿',system:'全身单人・标准系',angle:'正面'},[],[]);
    assert.equal(results.length,1);
    assert.equal(results[0].id,'full_single_P001_front');
    assert.equal(listEntries(items,true).length,288);
    assert.equal(listEntries(items,false).length,1439);
});
test('favorites and recents keep exact view identity and order', () => {
    const ids=['full_single_P001_side','full_single_P001_front'];
    assert.deepEqual(filterItems(items,{...state,collection:'recent'},[],ids).map(item=>item.id),ids);
    assert.deepEqual(filterItems(items,{...state,collection:'favorites'},[ids[0]],[]).map(item=>item.id),[ids[0]]);
});
test('unavailable or corrupt browser storage is harmless', () => {
    const storage=new Map();
    globalThis.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};
    writeLocal('favorites.builtin',['x']);
    assert.deepEqual(readLocal('favorites.builtin',[]),['x']);
    storage.set('pose-gallery-zh.v1.favorites.builtin','{broken');
    assert.deepEqual(readLocal('favorites.builtin',[]),[]);
    globalThis.localStorage={getItem(){throw Error('denied')},setItem(){throw Error('denied')}};
    assert.deepEqual(readLocal('favorites.builtin',[]),[]);
    assert.doesNotThrow(()=>writeLocal('favorites.builtin',[]));
});
