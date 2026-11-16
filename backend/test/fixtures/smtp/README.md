Test-only TLS fixtures for `test/smtpfake.ts`: a self-signed certificate and its key for `localhost` and `127.0.0.1`, generated once with
`openssl req -x509 -newkey rsa:2048 -nodes -days 36500 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1`.
Never trusted outside the tests (`setMailTestCa`); not a secret.
