# Releases

GitHub Actions checks types and tests before publishing. Pushes to `main` create a patch release, publish to npm, and create a GitHub release.

The first release uses the version in `package.json`. Later releases increment the published patch version. A retry reuses the prepared version.

## Initial npm setup

1. Sign in with `npm login` and publish the first version with `npm publish --access public`.
2. Configure npm trusted publishing for `@giladbarnea/pi-custom-footer`:
   - GitHub owner: `giladbarnea`
   - Repository: `custom-footer`
   - Workflow: `publish.yml`
   - Allow direct publishing with `npm publish`.
3. Run the Publish workflow for the first CI release. Later pushes publish automatically.

Trusted publishing uses GitHub OIDC. No npm token belongs in this repository.
