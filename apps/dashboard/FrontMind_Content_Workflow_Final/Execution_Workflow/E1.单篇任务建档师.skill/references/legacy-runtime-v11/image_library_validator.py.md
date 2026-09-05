#!/usr/bin/env python3
"""
FrontMind 企业提交图片库校验器（v9）

核心变化：
- 用户只需要提交图片库 ZIP 或目录，不再要求内置 image_library_manifest.json。
- 如图片库包含 manifest，则读取其中元数据；如没有 manifest，则自动扫描图片并生成标准化 manifest 与索引。
- 上传行为被视为“项目可用素材提交”，不再设置额外客户确认步骤。
- 仍会校验文件存在、格式、大小、重复哈希、显式受限版权等风险。
"""
from __future__ import annotations
import argparse, json, os, sys, zipfile, tempfile, hashlib, shutil, re
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict

IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp'}
ALLOWED_RIGHTS = {
    'client_submitted_for_project',
    'client_owned', 'client_authorized', 'licensed_for_media',
    'client_owned_or_authorized', 'public_official_with_permission', 'licensed_for_project',
    'unknown'
}
BLOCKED_RIGHTS = {'restricted', 'restricted_not_allowed', 'no_permission', 'copyright_blocked'}
MIN_SIZE_KB = 10
DEFAULT_USAGE = ['article', 'docx', 'html']


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return 'sha256:' + h.hexdigest()


def safe_id(text: str) -> str:
    text = re.sub(r'[^A-Za-z0-9_\-]+', '_', text).strip('_').lower()
    return text[:60] or 'asset'


def infer_asset_type(path: Path) -> str:
    s = str(path).lower()
    name = path.stem.lower()
    if any(k in s for k in ['logo', 'vi', 'brand', '商标', '标志']):
        return 'brand_material'
    if any(k in s for k in ['cert', 'certificate', 'award', 'license', '授权', '资质', '证书', '奖项']):
        return 'certificate_photo'
    if any(k in s for k in ['founder', '创始人']):
        return 'founder_photo'
    if any(k in s for k in ['team', 'staff', 'expert', 'teacher', 'consultant', 'advisor', '团队', '老师', '顾问', '专家']):
        return 'team_photo'
    if any(k in s for k in ['office', 'store', 'campus', 'environment', 'factory', 'lab', '门店', '办公室', '校区', '环境', '工厂', '实验室']):
        return 'office_photo'
    if any(k in s for k in ['case', 'customer', 'client', 'project', '现场', '案例', '客户', '项目']):
        return 'case_photo'
    if any(k in s for k in ['event', 'forum', 'meeting', 'signing', 'press', '活动', '发布会', '签约', '展会', '论坛']):
        return 'event_photo'
    if any(k in s for k in ['product', 'device', 'equipment', 'service', '产品', '设备', '服务']):
        return 'product_photo'
    if any(k in s for k in ['screenshot', 'media', 'report', '报道', '截图']):
        return 'media_clip'
    return 'other'


def infer_roles(asset_type: str) -> list[str]:
    mapping = {
        'brand_material': ['cover', 'logo', 'body'],
        'certificate_photo': ['certificate', 'body', 'case_proof'],
        'founder_photo': ['team', 'body'],
        'team_photo': ['team', 'body'],
        'office_photo': ['environment', 'body'],
        'case_photo': ['case_proof', 'body'],
        'event_photo': ['body', 'case_proof'],
        'product_photo': ['product', 'body'],
        'media_clip': ['screenshot', 'body'],
        'other': ['body']
    }
    return mapping.get(asset_type, ['body'])


def quality_grade(size_kb: float) -> str:
    if size_kb >= 500:
        return 'high'
    if size_kb >= 80:
        return 'usable'
    return 'low'


def extract_or_open_library(library_path: Path, unpack_dir: Path | None = None):
    if library_path.is_file() and library_path.suffix.lower() == '.zip':
        if unpack_dir is None:
            unpack_dir = Path(tempfile.mkdtemp(prefix='frontmind_imglib_'))
        if unpack_dir.exists():
            shutil.rmtree(unpack_dir)
        unpack_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(library_path, 'r') as zf:
            zf.extractall(unpack_dir)
        return unpack_dir, True
    if library_path.is_dir():
        return library_path, False
    raise FileNotFoundError(f'图片库不存在或格式不支持: {library_path}')


def find_manifest(base: Path):
    candidates = list(base.rglob('image_library_manifest.json')) + list(base.rglob('enterprise_image_library_manifest.json'))
    if not candidates:
        return None, None
    manifest_path = candidates[0]
    with manifest_path.open('r', encoding='utf-8') as f:
        manifest = json.load(f)
    return manifest_path, manifest


def discover_images(base: Path) -> list[Path]:
    imgs=[]
    for p in base.rglob('*'):
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS:
            if '__MACOSX' in p.parts or p.name.startswith('._'):
                continue
            imgs.append(p)
    return sorted(imgs)


def manifest_assets_by_path(manifest: dict | None) -> dict[str, dict]:
    out={}
    if not manifest:
        return out
    for a in manifest.get('assets') or []:
        rel = a.get('file_path') or ''
        if rel:
            out[Path(rel).name.lower()] = a
            out[rel.replace('\\','/').lower()] = a
    return out


def build_or_normalize_manifest(base: Path, manifest_path: Path | None, manifest: dict | None, brand: str | None):
    issues=[]
    now=datetime.now(timezone.utc).isoformat()
    images=discover_images(base)
    if not images:
        issues.append(('fatal', '图片库中没有找到 png/jpg/jpeg/webp 图片文件'))

    by_path=manifest_assets_by_path(manifest)
    seen_ids=set()
    seen_hashes={}
    normalized_assets=[]
    counters=defaultdict(int)
    base_for_rel = manifest_path.parent if manifest_path else base

    for img in images:
        rel_to_base = img.relative_to(base).as_posix()
        rel_to_manifest = img.relative_to(base_for_rel).as_posix() if base_for_rel in img.parents or img.parent == base_for_rel else rel_to_base
        meta = by_path.get(rel_to_manifest.lower()) or by_path.get(rel_to_base.lower()) or by_path.get(img.name.lower()) or {}
        asset_type = meta.get('asset_type') or infer_asset_type(img)
        counters[asset_type] += 1
        asset_id = meta.get('asset_id') or f"{asset_type}_{counters[asset_type]:03d}_{safe_id(img.stem)[:24]}"
        while asset_id in seen_ids:
            counters[asset_type] += 1
            asset_id = f"{asset_type}_{counters[asset_type]:03d}_{safe_id(img.stem)[:24]}"
        seen_ids.add(asset_id)

        size_kb = img.stat().st_size / 1024
        digest = sha256_file(img)
        if digest in seen_hashes:
            issues.append(('warning', f'{asset_id} 与 {seen_hashes[digest]} 文件哈希重复；仍保留但建议后续清理'))
        else:
            seen_hashes[digest]=asset_id
        if size_kb < MIN_SIZE_KB:
            issues.append(('warning', f'{asset_id} 图片过小: {size_kb:.1f}KB，可能不适合正文/DOCX'))

        rights_status = meta.get('rights_status') or 'client_submitted_for_project'
        if rights_status in BLOCKED_RIGHTS:
            issues.append(('error', f'{asset_id} rights_status={rights_status}，不可用于执行层'))
        elif rights_status not in ALLOWED_RIGHTS:
            issues.append(('warning', f'{asset_id} rights_status={rights_status} 未识别，已按 client_submitted_for_project 处理'))
            rights_status = 'client_submitted_for_project'
        if rights_status == 'unknown':
            issues.append(('warning', f'{asset_id} rights_status=unknown；因素材来自提交图片库暂允许入索引，请在实际发布前确认版权'))

        keywords = meta.get('scene_keywords') or [asset_type.replace('_photo','').replace('_',' '), img.stem]
        visual_roles = meta.get('visual_roles') or infer_roles(asset_type)
        rec_types = meta.get('recommended_article_types') or ['single_article']
        allowed_usage = meta.get('allowed_usage') or DEFAULT_USAGE

        normalized_assets.append({
            **meta,
            'asset_id': asset_id,
            'file_path': rel_to_base,
            'absolute_path': str(img.resolve()),
            'asset_type': asset_type,
            'description': meta.get('description') or f'用户提交图片库素材：{img.name}',
            'scene_keywords': keywords,
            'quality_grade': meta.get('quality_grade') or quality_grade(size_kb),
            'client_approved': meta.get('client_approved', True),
            'client_submitted': True,
            'submission_basis': 'implicit_by_submitted_image_library',
            'rights_status': rights_status,
            'allowed_usage': allowed_usage,
            'restricted_contexts': meta.get('restricted_contexts') or [],
            'people_release_status': meta.get('people_release_status') or 'not_applicable',
            'recommended_article_types': rec_types,
            'visual_roles': visual_roles,
            'file_size_kb': round(size_kb, 1),
            'file_hash': digest,
        })

    out = {
        'brand': brand or (manifest or {}).get('brand', ''),
        'library_id': (manifest or {}).get('library_id') or f"{safe_id(brand or 'brand')}_submitted_image_library",
        'library_version': (manifest or {}).get('library_version') or 'v1-auto',
        'created_at': (manifest or {}).get('created_at') or now,
        'manifest_source': 'provided_manifest' if manifest_path else 'auto_generated_from_submitted_library',
        'source_manifest_path': str(manifest_path) if manifest_path else None,
        'library_submission': {
            'submitted_by_client': True,
            'submitted_library_is_accepted_as_project_approved': True,
            'submission_source': 'user_uploaded_zip_or_folder',
            'submission_basis': 'implicit_by_submitted_image_library',
            'submitted_at': now,
            'usage_scope': DEFAULT_USAGE,
            'rights_statement': '素材来自用户提交的图片库；执行层不再要求单独 image_library_manifest.json 确认步骤。如有不可用素材，应在上传前移除或在可选 manifest 中标记 restricted_not_allowed。'
        },
        'assets': normalized_assets,
        'asset_count': len(normalized_assets),
        'validated_at': now,
    }
    if manifest:
        # 复制 manifest 的额外顶层字段，但不覆盖标准化结果。
        for k,v in manifest.items():
            if k not in out and k != 'assets':
                out[k]=v

    fatal = any(sev == 'fatal' for sev,_ in issues)
    error = any(sev == 'error' for sev,_ in issues)
    passed = not (fatal or error)
    out['validation_status'] = 'passed' if passed else 'failed'
    out['library_sha256'] = 'sha256:' + hashlib.sha256(json.dumps(out, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
    return passed, issues, out


def build_index(manifest: dict):
    index = {
        'brand': manifest.get('brand', ''),
        'library_id': manifest.get('library_id', ''),
        'library_sha256': manifest.get('library_sha256', ''),
        'manifest_source': manifest.get('manifest_source', ''),
        'by_asset_type': defaultdict(list),
        'by_visual_role': defaultdict(list),
        'by_article_type': defaultdict(list),
        'by_keyword': defaultdict(list),
        'assets': {}
    }
    for asset in manifest.get('assets', []):
        aid = asset['asset_id']
        index['assets'][aid] = asset
        index['by_asset_type'][asset.get('asset_type', 'other')].append(aid)
        for role in asset.get('visual_roles', []):
            index['by_visual_role'][role].append(aid)
        for art in asset.get('recommended_article_types', []):
            index['by_article_type'][art].append(aid)
        for kw in asset.get('scene_keywords', []):
            index['by_keyword'][kw].append(aid)
    for k in ['by_asset_type', 'by_visual_role', 'by_article_type', 'by_keyword']:
        index[k] = dict(index[k])
    return index


def write_report(path: Path, passed: bool, issues: list, manifest: dict):
    lines=[]
    lines.append('# 企业提交图片库校验报告')
    lines.append('')
    lines.append(f"- 品牌：{manifest.get('brand','')}")
    lines.append(f"- 图片库 ID：{manifest.get('library_id','')}")
    lines.append(f"- Manifest 来源：{manifest.get('manifest_source','')}")
    lines.append(f"- 校验状态：{'✅ 通过' if passed else '❌ 未通过'}")
    lines.append(f"- 可用素材数：{manifest.get('asset_count',0)}")
    lines.append(f"- 图片库哈希：{manifest.get('library_sha256','')}")
    lines.append('')
    lines.append('## 说明')
    lines.append('- 用户只需提交图片库 ZIP 或目录；`image_library_manifest.json` 为可选补充元数据，不再作为启动前置确认文件。')
    lines.append('- E0 已根据提交图片库自动生成标准化 manifest 与检索索引。')
    lines.append('- 显式标记为 restricted / restricted_not_allowed / no_permission 的素材会被阻断。')
    lines.append('')
    lines.append('## 问题清单')
    if not issues:
        lines.append('- 无')
    else:
        for sev,msg in issues:
            icon={'fatal':'🛑','error':'🔴','warning':'🟡'}.get(sev,'ℹ️')
            lines.append(f'- {icon} **{sev}**：{msg}')
    lines.append('')
    lines.append('## 素材类型统计')
    counts=defaultdict(int)
    for a in manifest.get('assets',[]):
        counts[a.get('asset_type','other')] += 1
    for k,v in sorted(counts.items()):
        lines.append(f'- {k}: {v}')
    path.write_text('\n'.join(lines), encoding='utf-8')


def main():
    ap=argparse.ArgumentParser(description='FrontMind 企业提交图片库校验器（manifest 可选）')
    ap.add_argument('--library', required=True, help='图片库 ZIP 或目录')
    ap.add_argument('--brand', default='', help='品牌名称')
    ap.add_argument('--output-manifest', default='', help='标准化 manifest 输出路径')
    ap.add_argument('--report', default='', help='校验报告输出路径')
    ap.add_argument('--index', default='', help='检索索引输出路径')
    ap.add_argument('--ai-feedback', action='store_true')
    args=ap.parse_args()

    brand_safe = safe_id(args.brand or 'brand')
    out_manifest = Path(args.output_manifest or f'E0_{brand_safe}_submitted_image_library_manifest.json')
    out_report = Path(args.report or f'E0_{brand_safe}_image_library_validation_report.md')
    out_index = Path(args.index or f'E0_{brand_safe}_image_library_index.json')
    unpack_dir = out_manifest.parent / f'E0_{brand_safe}_image_library_unpacked'

    try:
        base, extracted = extract_or_open_library(Path(args.library), unpack_dir=unpack_dir)
        manifest_path, manifest = find_manifest(base)
        passed, issues, normalized = build_or_normalize_manifest(base, manifest_path, manifest, args.brand or None)
        index = build_index(normalized)

        out_manifest.parent.mkdir(parents=True, exist_ok=True)
        out_manifest.write_text(json.dumps(normalized, ensure_ascii=False, indent=2), encoding='utf-8')
        out_index.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding='utf-8')
        write_report(out_report, passed, issues, normalized)

        if args.ai_feedback:
            print(json.dumps({'passed': passed, 'issues': [{'severity':s,'issue':m} for s,m in issues], 'manifest': str(out_manifest), 'report': str(out_report), 'index': str(out_index), 'manifest_source': normalized.get('manifest_source')}, ensure_ascii=False, indent=2))
        else:
            print(f"{'✅' if passed else '❌'} 图片库校验{'通过' if passed else '未通过'}")
            print(f"Manifest: {out_manifest}")
            print(f"Report: {out_report}")
            print(f"Index: {out_index}")
            if issues:
                for sev,msg in issues:
                    print(f'[{sev}] {msg}')
        sys.exit(0 if passed else 1)
    except Exception as e:
        if args.ai_feedback:
            print(json.dumps({'passed': False, 'issues': [{'severity':'fatal','issue':str(e)}]}, ensure_ascii=False, indent=2))
        else:
            print(f'❌ 图片库校验失败: {e}', file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
