# Cloudflare R2 CORS for Dashboard direct uploads

Browser clients upload media with a short-lived presigned `PUT` URL issued by
the API. The Dashboard origin must be allowed by the R2 bucket CORS policy.

## Example policy

Replace the origin with the real Dashboard origin. Do **not** use `*` in
production.

```json
[
  {
    "AllowedOrigins": [
      "https://dashboard.example.com"
    ],
    "AllowedMethods": [
      "PUT"
    ],
    "AllowedHeaders": [
      "Content-Type"
    ],
    "ExposeHeaders": [
      "ETag"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

## Notes

* CORS is browser policy, not authorization. A valid presigned URL is still
  required for the `PUT`.
* The presigned URL grants only one operation on one server-generated object
  key for a short TTL.
* The browser must send the exact signed `Content-Type` header value. A
  different `Content-Type` will fail signature verification at R2.
* Local development may add `http://localhost:3000` (or the real Dashboard
  dev origin) to `AllowedOrigins`.
