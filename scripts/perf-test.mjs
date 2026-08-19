#!/usr/bin/env node
/**
 * Performance regression test (170-node synthetic load).
 *
 * Boots a mock server serving a 170-node dataset (chain + cross dependencies,
 * mixed states, streaming runtime events, periodic state flips), drives real
 * headless Chrome over CDP, opens the plugin panel + a node popup, drags a
 * node, and samples requestAnimationFrame gaps for ~6s while the 2s state
 * poll churns. Asserts the UI stays fluid: mean frame gap < 25ms,
 * max gap < 150ms, zero uncaught exceptions.
 *
 * Usage: node scripts/perf-test.mjs
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 8893
const CDP_PORT = 9335
const N = 169 // plugins; +core = 170 nodes
const html = readFileSync(join(ROOT, '..', 'assets', 'index.html'), 'utf8')

/* ---------- synthetic big dataset ---------- */
function pad(i){return String(i).padStart(3,'0')}
function pid(i){return 'plugin-perf-'+pad(i)}
function buildNodes(){
  const nodes=[{id:'core',name:'DSH 核心',kind:'core',state:'active',stateText:'已激活',injects:[],provides:[{service:'logger',consumers:[pid(1)]},{service:'config',consumers:[pid(2)]}],dependsOn:[],dependedBy:[pid(1),pid(2)],toolCount:8}]
  for(let i=1;i<=N;i++){
    const state=(i%5===0)?'error':(i%7===0)?'disabled':(i%11===0)?'pending':'active'
    const injects=[{service:'logger',provider:'core'}]
    const dependsOn=['core']
    const dependedBy=[]
    if(i>1){injects.push({service:'svc-'+(i-1),provider:pid(i-1)});dependsOn.push(pid(i-1))}
    if(i>3){injects.push({service:'svc-'+(i-3),provider:pid(i-3)});dependsOn.push(pid(i-3))}
    const consumers=[]
    if(i<N)consumers.push(pid(i+1))
    if(i+2<=N)consumers.push(pid(i+2))
    for(const c of consumers)dependedBy.push(c)
    nodes.push({id:pid(i),name:'perf-plugin-'+pad(i),kind:'plugin',state,stateText:state==='active'?'已激活':state==='error'?'错误':state==='disabled'?'已停用':'等待依赖',injects,provides:[{service:'svc-'+i,consumers}],dependsOn,dependedBy,toolCount:0})
  }
  return nodes
}
function buildEdges(nodes){
  const edges=[]
  for(const n of nodes){
    if(n.id==='core')continue
    for(const inj of n.injects)edges.push({source:inj.provider,target:n.id,kind:'dependency'})
  }
  return edges
}
const allNodes=buildNodes()
const allEdges=buildEdges(allNodes)
const services=['logger','config'].concat(allNodes.slice(1).map(function(n){return 'svc-'+n.id.replace('plugin-perf-','')}))
const counts={plugins:N,active:allNodes.filter(function(n){return n.state==='active'}).length-1,tools:8,services:services.length}

/* periodic churn: flip states + stream events so polls do real work */
let poll=0
function churn(nodes){
  poll++
  const flips=[pid(1+(poll*2)%N),pid(1+(poll*2+1)%N)]
  for(const id of flips){
    const n=nodes.find(function(x){return x.id===id})
    if(!n)continue
    n.state=n.state==='active'?'disabled':'active'
    n.stateText=n.state==='active'?'已激活':'已停用'
  }
}
function statePayload(){
  const nodes=JSON.parse(JSON.stringify(allNodes))
  churn(nodes)
  const now=Date.now()
  const evs=[]
  for(let k=0;k<2;k++){
    const c=poll*10+k
    evs.push({callId:'c'+c,timestamp:now+k*3,tool:'perf-tool-'+pad(c%50),isError:(c%7===0)})
  }
  return JSON.stringify({nodes:nodes,edges:allEdges,services:services,counts:counts,runtimeEvents:evs,updatedAt:now})
}

/* ---------- mock server ---------- */
const actionLog=[]
const server=createServer(function(req,res){
  const u=new URL(req.url,'http://x')
  if(u.pathname==='/'){
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'})
    res.end(html);return
  }
  if(u.pathname==='/state'){
    res.writeHead(200,{'content-type':'application/json'})
    res.end(statePayload());return
  }
  if(u.pathname==='/action'){
    let body=''
    req.on('data',function(d){body+=d})
    req.on('end',function(){
      try{actionLog.push(JSON.parse(body))}catch{}
      res.writeHead(200,{'content-type':'application/json'})
      res.end(JSON.stringify({ok:true,message:'ok'}))
    });return
  }
  res.writeHead(404);res.end('nope')
})

/* ---------- CDP client (same as ui-test) ---------- */
class CDP{
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.exceptions=[]
    ws.addEventListener('message',function(ev){
      const msg=JSON.parse(ev.data)
      if(msg.id&&this.pending.has(msg.id)){const e=this.pending.get(msg.id);this.pending.delete(msg.id);msg.error?e.reject(new Error(msg.error.message)):e.resolve(msg.result);return}
      if(msg.method==='Runtime.exceptionThrown')this.exceptions.push(msg.params)
    }.bind(this))}
  static async connect(port){
    const deadline=Date.now()+15000;let tabs=null
    while(Date.now()<deadline){
      try{tabs=await fetch('http://127.0.0.1:'+port+'/json').then(function(r){return r.json()});if(tabs.length)break}catch{}
      await new Promise(function(r){setTimeout(r,300)})
    }
    if(!tabs||!tabs.length)throw new Error('chrome CDP not reachable on port '+port)
    const page=tabs.find(function(t){return t.type==='page'})
    const ws=new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(function(resolve,reject){ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})})
    return new CDP(ws)
  }
  send(method,params){return new Promise(function(resolve,reject){const id=++this.id;this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params:params||{}}))}.bind(this))}
  async eval(expression){
    const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})
    if(r.exceptionDetails)throw new Error('page exception: '+JSON.stringify(r.exceptionDetails).slice(0,1200))
    return r.result?r.result.value:undefined
  }
  async mouse(type,x,y,opts){opts=opts||{};await this.send('Input.dispatchMouseEvent',{type,x,y,button:opts.button||'none',buttons:opts.buttons||0,clickCount:opts.clickCount||0,deltaX:0,deltaY:0,modifiers:0})}
  async clickAt(x,y){await this.mouse('mousePressed',x,y,{button:'left',buttons:1,clickCount:1});await this.mouse('mouseReleased',x,y,{button:'left',buttons:1,clickCount:1})}
  async drag(x1,y1,x2,y2){
    await this.mouse('mousePressed',x1,y1,{button:'left',buttons:1,clickCount:1})
    for(let i=1;i<=8;i++){await this.mouse('mouseMoved',x1+((x2-x1)*i)/8,y1+((y2-y1)*i)/8,{button:'left',buttons:1});await new Promise(function(r){setTimeout(r,16)})}
    await this.mouse('mouseReleased',x2,y2,{button:'left',buttons:1,clickCount:1})
  }
}
const sleep=function(ms){return new Promise(function(r){setTimeout(r,ms)})}
let failures=0
function check(cond,label){if(cond)console.log('  ok  '+label);else{failures++;console.error('  FAIL '+label)}}

async function run(){
  await new Promise(function(resolve){server.listen(PORT,resolve)})
  console.log('mock server :'+PORT+' serving 170 nodes')
  const chrome=spawn(CHROME,['--headless=new','--no-sandbox','--disable-gpu','--remote-debugging-port='+CDP_PORT,'--window-size=1440,900','about:blank'])
  try{
    const cdp=await CDP.connect(CDP_PORT)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Page.navigate',{url:'http://127.0.0.1:'+PORT+'/'})
    // wait for the full 170-node graph
    let ready=false
    for(let i=0;i<60;i++){
      await sleep(250)
      const n=await cdp.eval('(window.__pgTest?window.__pgTest.count():-1)')
      if(n===170){ready=true;break}
      if(n>=0&&n!==170){console.log('  graph ready with '+n+' nodes (waiting for 170)')}
    }
    check(ready,'170-node graph rendered')
    if(!ready){console.error('perf-test: ABORT - graph never reached 170 nodes');process.exitCode=1;return}
    // open the plugin panel (large list) + a node popup
    await cdp.eval('(function(){var b=document.querySelector(\'.dock button[data-panel="plugins"]\');if(b)b.click();return !!b})()')
    await sleep(300)
    await cdp.eval('(window.__pgTest.select("plugin-perf-001"),true)')
    await sleep(300)
    // start rAF gap sampler
    await cdp.eval('(window.__pgG=[],window.__pgT=performance.now(),(function s(t){window.__pgG.push(t-window.__pgT),window.__pgT=t,requestAnimationFrame(s)})(window.__pgT),true)')
    // drag a node through the physics for ~1.5s mid-sample
    const sc=await cdp.eval('(function(){var el=document.querySelector(\'#nodes .node[data-id="plugin-perf-050"] circle.core\');if(!el)return null;var r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
    if(sc){await sleep(800);await cdp.drag(sc.x,sc.y,sc.x+260,sc.y+150)}
    await sleep(6000)
    const stats=await cdp.eval('(function(){var g=window.__pgG||[];var sum=0,max=0,p95=0,over=0;var a=g.slice(1);for(var i=0;i<a.length;i++){var v=a[i];sum+=v;if(v>max)max=v;if(v>33)over++}a.sort(function(x,y){return x-y});p95=a[Math.floor(a.length*0.95)]||0;return{count:a.length,mean:+(sum/a.length).toFixed(2),p95:+p95.toFixed(2),max:+max.toFixed(2),over33:over}})()')
    const alive=await cdp.eval('window.__pgTest?window.__pgTest.count():-1')
    console.log('  frame stats: '+JSON.stringify(stats))
    check(stats.count>120,'enough frames sampled ('+stats.count+')')
    check(stats.mean<25,'mean frame gap < 25ms ('+stats.mean+'ms)')
    check(stats.max<150,'max frame gap < 150ms ('+stats.max+'ms)')
    check(stats.p95<35,'p95 frame gap < 35ms ('+stats.p95+'ms)')
    check(alive===170,'graph still alive after stress (170 nodes)')
    check(cdp.exceptions.length===0,'zero uncaught page exceptions')
    if(failures)console.error('perf-test: '+failures+' FAILURES')
    else console.log('perf-test: fluid under 170-node load')
    process.exitCode=failures?1:0
  }finally{
    chrome.kill()
    server.close()
  }
}
run().catch(function(e){console.error(e);process.exitCode=1})
