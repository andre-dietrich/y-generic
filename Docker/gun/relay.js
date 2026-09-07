// Gun relay for the classroom image (liascript/gundb): gun's examples/http.js
// with multicast and AXE off - one relay, alone, reached by an IPv4 address.
// See relay.sh for why (multicast meshes with other relays on the LAN).
const fs = require("fs")
const Gun = require("gun")

const port = process.env.PORT || 8765
const isHttps = !!process.env.HTTPS_KEY
const server = isHttps
  ? require("https").createServer(
      {
        key: fs.readFileSync(process.env.HTTPS_KEY),
        cert: fs.readFileSync(process.env.HTTPS_CERT),
      },
      Gun.serve(__dirname)
    )
  : require("http").createServer(Gun.serve(__dirname))

Gun({ web: server.listen(port), multicast: false, axe: false })

// `docker stop` sends SIGTERM and kills after 10 s (exit 137) if nobody
// listens; end cleanly instead so the volume's radata is flushed.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`\n${signal}: stopping`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}

const host = `${isHttps ? "https" : "http"}://${process.env.RELAY_IP || "127.0.0.1"}:${port}`

console.log()
console.log("Gun relay running on\n")
console.log(`    ${host}/gun\n`)

if (isHttps) {
  console.log(`Self-signed certificate: open ${host}/ once in a browser on this and every other device`)
  console.log("and accept the warning, before using the address above as the gundb relay server in LiaScript -")
  console.log("otherwise the connection fails silently.\n")
}