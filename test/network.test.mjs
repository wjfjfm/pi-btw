import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {spawn} from 'node:child_process';

test('SDK worker transport uses HTTP_PROXY for fetch instead of direct DNS', {timeout:15000}, async t=>{
  let tunnels=0;
  const sockets=new Set();
  const target=createServer((_req,res)=>res.end('proxied reply'));
  const proxy=createServer();
  for(const server of [target,proxy])server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  t.after(()=>{for(const socket of sockets)socket.destroy();target.close();proxy.close();});
  await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
  proxy.on('connect',(_req,client,head)=>{
    tunnels++;
    const upstream=connect(target.address().port,'127.0.0.1',()=>{
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)upstream.write(head);upstream.pipe(client);client.pipe(upstream);
    });
    sockets.add(upstream);upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${proxy.address().port}`;
  const code=`import {configureNetwork} from ${JSON.stringify(new URL('../dist/network.js',import.meta.url).href)};await configureNetwork({});console.log(await (await fetch('http://btw-test.invalid/',{signal:AbortSignal.timeout(5000)})).text());`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,HTTP_PROXY:url,HTTPS_PROXY:url,http_proxy:url,https_proxy:url,NO_PROXY:'',no_proxy:''}});
  t.after(()=>child.kill());let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
  const exit=await new Promise(resolve=>child.on('exit',resolve));
  assert.equal(exit,0,output);assert.match(output,/proxied reply/);assert.ok(tunnels>0);
});
