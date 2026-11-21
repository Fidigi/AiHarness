// Only actual output-module delivery followed by synthesis acceptance counts.
// Queued SSML, an accessibility-tree node or an Orca debug line alone does not.
export function moduleSpoke(log, phrase) {
  return log.split('Command sent to output module: |<speak>').slice(1).some(part => {
    const end = part.indexOf('</speak>');
    return end >= 0 && part.slice(0, end).replace(/<[^>]+>/g, '').includes(phrase)
      && part.slice(end).includes('200 OK SPEAKING');
  });
}

export function commandStatus({ code }) {
  return code ?? 1;
}
