/**
 * 财经日历自动更新脚本 (GitHub Actions 每日运行)
 *
 * 数据源: 美国劳工统计局 BLS 发布日程页 (官方公开, 无需 key)
 *   - Employment Situation (非农就业报告)
 *   - Consumer Price Index (CPI)
 *   - Producer Price Index (PPI)
 *   - Real Earnings
 *
 * 输出: 仓库根目录 events-auto.json (FinanceEvent 格子式, 前端同源 fetch 加载)
 * 容错: 任一源失败跳过; 全部失败保留旧文件 (exit 0, 不破坏线上)
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const OUT = resolve(process.cwd(), 'events-auto.json')

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTH_IDX = Object.fromEntries(MONTHS.map((m, i) => [m, i]))

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** BLS 关注的发布项与中文映射 */
const BLS_ITEMS = [
  { pattern: /Employment\s+Situation/i, title: '美国非农就业报告 (NFP)', kind: 'data', impact: 3, note: '美国劳工统计局月度就业报告, 含失业率与非农新增就业, 每月首个周五前后发布' },
  { pattern: /Consumer\s+Price\s+Index/i, title: '美国CPI通胀数据', kind: 'data', impact: 3, note: '消费者价格指数, 美联储最关注的通胀指标之一' },
  { pattern: /Producer\s+Price\s+Index/i, title: '美国PPI生产者物价指数', kind: 'data', impact: 2, note: '生产者价格指数, 通胀前瞻指标' },
  { pattern: /Real\s+Earnings/i, title: '美国实际收入报告', kind: 'data', impact: 1, note: '实际平均时薪数据' },
  { pattern: /Job\s+Openings/i, title: '美国JOLTS职位空缺报告', kind: 'data', impact: 2, note: '职位空缺与劳动力流动调查' },
]

/** 抓取 BLS 指定年份日程页 HTML (403 时回退 r.jina.ai 文本代理) */
async function fetchBlsSchedule(year) {
  const url = `https://www.bls.gov/schedule/news-release/${year}_sched.htm`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(25000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } catch (e) {
    console.log(`[info] BLS 直连失败(${e.message}), 尝试 jina 代理`)
    const res2 = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'User-Agent': UA, Accept: 'text/plain' },
      signal: AbortSignal.timeout(35000),
    })
    if (!res2.ok) throw new Error(`jina HTTP ${res2.status}`)
    return await res2.text()
  }
}

/** FOMC 官网解析: 自动提取当年+次年议息会议日期 (含 SEP 点阵图标记) */
async function fetchFomcCalendar() {
  const url = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'
  let html
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    html = await res.text()
  } catch (e) {
    console.log(`[info] FOMC 直连失败(${e.message}), 尝试 jina 代理`)
    const res2 = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'User-Agent': UA, Accept: 'text/plain' },
      signal: AbortSignal.timeout(35000),
    })
    if (!res2.ok) throw new Error(`jina HTTP ${res2.status}`)
    html = await res2.text()
  }

  // 剥离 HTML 标签 (页面中月份与日期分属不同 div, 必须先拍平再匹配)
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')

  const events = []
  // 按 "YYYY FOMC Meetings" 分块, 块内匹配 "Month D-D" / "Month D-D*" (会议日期为区间, 可与纪要发布日 "Month D, YYYY" 区分)
  const chunks = text.split(/(\d{4})\s+FOMC\s+Meetings/i)
  for (let i = 1; i + 1 < chunks.length; i += 2) {
    const year = Number(chunks[i])
    const body = chunks[i + 1]
    const re = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})\\s*(\\*?)`, 'g')
    let m
    while ((m = re.exec(body)) !== null) {
      const [, mon, d1, d2, sep] = m
      const mm = String(MONTH_IDX[mon] + 1).padStart(2, '0')
      const dd1 = String(Number(d1)).padStart(2, '0')
      const dd2 = String(Number(d2)).padStart(2, '0')
      events.push({
        id: `fomc-${year}-${mm}`,
        title: `美联储FOMC议息会议 (${mon.slice(0, 3)})`,
        date: `${year}-${mm}-${dd1}`,
        endDate: `${year}-${mm}-${dd2}`,
        region: 'us',
        kind: 'fed',
        location: '华盛顿',
        impact: 3,
        note: sep
          ? '附带经济预期(SEP)与点阵图, 决议美东次日14:00(北京时间次日凌晨2:00)公布'
          : '决议美东次日14:00(北京时间次日凌晨2:00)公布, 随后主席新闻发布会',
        auto: true,
      })
    }
  }
  return events
}

/** 从 HTML 中提取某发布项的全部日期 (Month D, YYYY) */
function extractDates(html, pattern) {
  const events = []
  // 匹配 "Release Name ...附近的... Month DD, YYYY"; BLS 表格行内 release 与日期在同一行
  const dateRe = new RegExp(`(${MONTHS.join('|')})\\s+(\\d{1,2}),\\s*(\\d{4})`, 'g')
  // 按行/表格行切分, 找含 release 名称的片段
  const rows = html.split(/<tr|<br|<\/p>/i)
  for (const row of rows) {
    if (!pattern.test(row)) continue
    dateRe.lastIndex = 0
    let m
    while ((m = dateRe.exec(row)) !== null) {
      const [, mon, day, yr] = m
      const mm = String(MONTH_IDX[mon] + 1).padStart(2, '0')
      const dd = String(Number(day)).padStart(2, '0')
      events.push(`${yr}-${mm}-${dd}`)
    }
  }
  return [...new Set(events)]
}

async function main() {
  const thisYear = new Date().getUTCFullYear()
  const years = [thisYear, thisYear + 1]
  const events = []
  const sources = []

  // ---- 源1: BLS 经济数据发布日程 ----
  for (const item of BLS_ITEMS) {
    const dates = new Set()
    for (const y of years) {
      try {
        const html = await fetchBlsSchedule(y)
        for (const d of extractDates(html, item.pattern)) dates.add(d)
        if (!sources.includes('BLS')) sources.push('BLS')
      } catch (e) {
        console.log(`[warn] BLS ${y} 抓取失败: ${e.message}`)
      }
    }
    for (const date of [...dates].sort()) {
      events.push({
        id: `bls-${item.title}-${date}`,
        title: item.title,
        date,
        region: 'us',
        kind: item.kind,
        location: '华盛顿 (美东 8:30)',
        impact: item.impact,
        note: item.note,
        auto: true,
      })
    }
    console.log(`[ok] ${item.title}: ${dates.size} 个日期`)
  }

  // ---- 源2: 美联储 FOMC 官网日程 ----
  try {
    const fomc = await fetchFomcCalendar()
    events.push(...fomc)
    if (fomc.length && !sources.includes('Fed')) sources.push('Fed')
    console.log(`[ok] FOMC: ${fomc.length} 次会议`)
  } catch (e) {
    console.log(`[warn] FOMC 抓取失败: ${e.message}`)
  }

  if (events.length === 0) {
    console.log('[skip] 无任何数据源成功, 保留旧文件')
    return
  }

  // 去重 + 只保留未来 120 天内与最近 3 天 (历史供回看)
  const now = Date.now()
  const filtered = events.filter((e) => {
    const t = new Date(e.date + 'T00:00:00Z').getTime()
    return t > now - 3 * 86400_000 && t < now + 120 * 86400_000
  })

  const payload = {
    updated: new Date().toISOString(),
    sources,
    events: filtered.sort((a, b) => (a.date < b.date ? -1 : 1)),
  }

  // 内容无变化则不写 (避免每日空提交)
  if (existsSync(OUT)) {
    try {
      const old = JSON.parse(readFileSync(OUT, 'utf8'))
      if (JSON.stringify(old.events) === JSON.stringify(payload.events)) {
        console.log('[skip] 事件无变化, 不更新文件')
        return
      }
    } catch { /* 忽略旧文件解析失败 */ }
  }

  writeFileSync(OUT, JSON.stringify(payload, null, 1) + '\n', 'utf8')
  console.log(`[done] 写入 ${filtered.length} 个自动事件 -> events-auto.json (来源: ${sources.join(',')})`)
}

main().catch((e) => {
  console.error('[fatal]', e)
  process.exit(0) // 失败不阻塞, 保留旧数据
})
