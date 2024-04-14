## helm deploy action

GitHub action to deploy a helm chart to kubernetes using GitHub actions.

#### Example 1 (helm upgrade, public chart)

```yaml
# .github/workflows/deploy.yml
name: Deploy
on: ['deployment']

jobs:
  deployment:
    runs-on: 'ubuntu-latest'
    steps:
    - uses: actions/checkout@v1

    - name: 'Deploy'
      uses: 'romnn/helm-deploy-action@master'
      with:
        command: 'upgrade'
        release: 'my-release'
        chart: 'nginx-stable/nginx-ingress'
        repo: 'https://helm.nginx.com/stable'
        repo-alias: 'nginx-stable'
        namespace: 'default'
        github-token: '${{ secrets.GITHUB_TOKEN }}'
        values: |
          foo: bar
        value-files: >-
        [
          "values.yaml",
          "values.production.yaml"
        ]
      env:
        KUBECONFIG_FILE: '${{ secrets.KUBECONFIG }}'
```

#### Value file interpolation

The following syntax allows variables to be used in value files:

- `${{ secrets.KEY }}`: References secret variables passed in the secrets input.
- `${{ deployment }}`: References the deployment event that triggered this
  action.

#### Testing

You can run the action locally.
Action input parameters can be passed as environment variables with the `INPUT_` prefix.

```bash
env 'INPUT_COMMAND="push"' 'INPUT_REPO-USERNAME="test"' yarn run run
```

Tests are run as part of the actions CI pipeline and can be run locally using [act](https://github.com/nektos/act):

```bash
act --platform ubuntu-latest=lucasalt/act_base:latest
```
