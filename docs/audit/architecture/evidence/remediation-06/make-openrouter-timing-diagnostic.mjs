import {readFile, writeFile} from 'node:fs/promises';
const input = await readFile('packages/core/src/providers/openrouter-completions.test.ts','utf8');
let text=input;
function replace(oldText,newText){if(text.split(oldText).length!==2)throw Error('Diagnostic anchor not unique');text=text.replace(oldText,newText);}
replace("async model => {\n    const reference = completions.rows.find", `async model => {
    const started=performance.now(), initialUsage=process.resourceUsage(), stages: unknown[]=[];
    let stage='fixture', iteration=0;
    const mark=(name:string)=>{ stage=name; stages.push({stage,iteration,ms:Math.round((performance.now()-started)*100)/100}); };
    const dump=(event:string)=>{const usage=process.resourceUsage();console.log('OPENROUTER_TIMING',JSON.stringify({event,model,stage,iteration,elapsedMs:performance.now()-started,cpuUserUs:usage.userCPUTime-initialUsage.userCPUTime,cpuSystemUs:usage.systemCPUTime-initialUsage.systemCPUTime,stages}));};
    const observer=setTimeout(()=>dump('near-original-deadline'),4800);
    try {
    const reference = completions.rows.find`);
replace("      const provider = new Ctor({ type: 'openrouter', model, apiKey: 'disposable-openrouter-c', baseUrl }), user:", "      iteration++; mark('provider-create');\n      const provider = new Ctor({ type: 'openrouter', model, apiKey: 'disposable-openrouter-c', baseUrl }), user:");
replace("      events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;\n      const firstResult", "      mark('initial-and-replay-requests');\n      events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;\n      const firstResult");
replace("      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-openrouter-c-replay-'))", "      mark('create-private-store');\n      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-openrouter-c-replay-'))");
replace("        await runToolLoop({ sessionManager: manager", "        mark('tool-loop');\n        await runToolLoop({ sessionManager: manager");
replace("        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded", "        mark('reload-export');\n        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded");
replace("        await restarted.appendContextEdit(session.id", "        mark('edit-clone');\n        await restarted.appendContextEdit(session.id");
replace("        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes", "        mark('compaction');\n        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes");
replace("      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }", "      } finally { mark('cleanup'); await registry.shutdown(); await rm(root, { recursive: true, force: true }); }");
replace("    expect(calls).toHaveLength(108);", "    mark('final-108-requests-assertion');\n    expect(calls).toHaveLength(108);");
// Close the diagnostic observer around only the original parameterized case.
replace("  });\n\n  it('pins private C body identity/prices", "    } finally { clearTimeout(observer); dump('finished'); }\n  });\n\n  it('pins private C body identity/prices");
await writeFile('/tmp/architecture-remediation-05/openrouter-timing-diagnostic.test.ts',text);
